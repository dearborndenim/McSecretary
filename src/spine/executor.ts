import type Database from 'better-sqlite3';
import { getProposalById, recordExecution } from '../db/proposal-queries.js';
import { insertEvent } from '../db/event-queries.js';
import { resolveHand, type BrandConfig } from './brand-config.js';
import { validateEmailPayload, type EmailHandRequest, type EmailHandResult } from './email-hand.js';
import { validateGraphPayload, runGraphDispatch, GRAPH_ACTION_TYPE } from './graph-hand.js';
import type { ActionPayload, ProposalRow } from './types.js';

export interface ExecutorDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  env: Record<string, string | undefined>;
  loadBrand: (brandId: string) => BrandConfig;
  now: () => string;
  /**
   * The built-in `email` hand (spec §12.4). Absent means "this deployment
   * cannot send mail" and an `email` proposal fails rather than silently
   * doing nothing. Wired in `wiring.ts`; tests inject a stub.
   */
  sendEmail?: (req: EmailHandRequest) => Promise<EmailHandResult>;
}

export type ExecutionResult =
  | { ok: true; http_status: number; body: unknown; recorded?: boolean }
  | { ok: false; http_status?: number; body?: unknown; error?: string; recorded?: boolean };

/** Thrown inside the graph hand's transaction to roll it back; never escapes. */
class DispatchNotRecorded extends Error {}

const EXECUTABLE = new Set(['pending', 'approved', 'approved_with_edit']);
const METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** Max chars of a hand's response body persisted on the proposal row. */
const STORED_BODY_CAP = 16384;
/** Max chars of a hand's `notify` field surfaced in a report/reply message. */
const NOTIFY_CAP = 600;

// eslint-disable-next-line no-control-regex -- deliberately stripping control chars
const CONTROL_CHARS = /[\x00-\x1F\x7F]/g;

function cleanNotify(s: string): string | undefined {
  const cleaned = s.replace(CONTROL_CHARS, '').trim();
  if (!cleaned) return undefined;
  return cleaned.length > NOTIFY_CAP ? cleaned.slice(0, NOTIFY_CAP) : cleaned;
}

/**
 * Pull an optional `notify` string out of a successful execution's response
 * body, sanitized for direct inclusion in a Telegram message: control
 * characters stripped, trimmed, and capped to NOTIFY_CAP chars. Anything
 * other than a non-empty string field (missing, wrong type, empty/whitespace)
 * is ignored.
 *
 * Falls back to `title + ": " + summary` (also cleaned and capped) when
 * `notify` is absent but the body carries both as strings — the shape the
 * built-in `notes` hand's response takes, so a card-only proposal auto-executed
 * at level 3 still gets a sensible one-line report without every notes caller
 * having to set `notify` explicitly.
 */
export function extractNotify(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const rec = body as Record<string, unknown>;
  if (typeof rec.notify === 'string') {
    const cleaned = cleanNotify(rec.notify);
    if (cleaned) return cleaned;
  }
  if (typeof rec.title === 'string' && typeof rec.summary === 'string') {
    return cleanNotify(`${rec.title}: ${rec.summary}`);
  }
  return undefined;
}

/**
 * Resolve a hand-relative path against the hand's base URL; refuse anything
 * that leaves the hand's origin and base path. `path` is agent-supplied, so
 * it is never concatenated raw — `@`, `//`, `:port`, `?`, `#`, `\\` and `..`
 * would otherwise move the request (and the hand's bearer) off-origin.
 */
export function resolveHandUrl(baseUrl: string, path: string): { ok: true; href: string } | { ok: false; error: string } {
  if (typeof path !== 'string' || !/^\/(?!\/)/.test(path)) {
    return { ok: false, error: `Invalid path: must start with a single '/'` };
  }
  // RFC 3986 pchar allowlist (unreserved + sub-delims + ':' + '/' + pct-encoding).
  // Positive match, so '@', '?', '#', '\\', whitespace and control chars are all refused.
  if (!/^\/[A-Za-z0-9._~%!$&'()*+,;=:\/-]*$/.test(path)) {
    return { ok: false, error: 'Invalid path: only unreserved and sub-delim characters are allowed' };
  }
  // The URL parser keeps '%2f'/'%2e' literal (so the origin check passes), but an upstream that decodes them could be walked.
  if (/%2[fe]/i.test(path)) {
    return { ok: false, error: 'Invalid path: percent-encoded slash or dot' };
  }
  let base: URL;
  let u: URL;
  try {
    base = new URL(baseUrl);
    const basePath = base.pathname.replace(/\/*$/, '');
    u = new URL(basePath + path, base.origin);
    if (u.origin !== base.origin || !u.pathname.startsWith(`${basePath}/`)) {
      return { ok: false, error: 'Path escapes hand origin' };
    }
  } catch {
    return { ok: false, error: 'Invalid hand URL or path' };
  }
  return { ok: true, href: u.href };
}

function validatePayload(payload: ActionPayload): string | null {
  if (!METHODS.has(payload.method)) return `Invalid method: ${String(payload.method)}`;
  if (typeof payload.body !== 'object' || payload.body === null || Array.isArray(payload.body)) {
    return 'Invalid body: must be a JSON object';
  }
  return null;
}

/** Max bytes of a hand's response body carried on the `*_executed` spine event. */
const EVENT_RESPONSE_TRUNCATE_BYTES = 4096;

/** Pure-card notes proposals (a report/warning/alert/flag with no downstream agent to wake) never emit. */
const SUPPRESSED_NOTES_SUFFIXES = ['_report', '_warning', '_alert', '_flag'];

function isSuppressedNotesCard(hand: string, actionType: string): boolean {
  return hand === 'notes' && SUPPRESSED_NOTES_SUFFIXES.some((s) => actionType.endsWith(s));
}

/** JSON body too big to carry on the event verbatim is stringified and byte-truncated instead. */
function truncateResponseForEvent(body: unknown): unknown {
  const json = JSON.stringify(body ?? null) ?? 'null';
  if (Buffer.byteLength(json, 'utf8') <= EVENT_RESPONSE_TRUNCATE_BYTES) return body;
  let sliced = json;
  while (sliced.length > 0 && Buffer.byteLength(sliced, 'utf8') > EVENT_RESPONSE_TRUNCATE_BYTES) {
    sliced = sliced.slice(0, -1);
  }
  return `${sliced}…[truncated]`;
}

/** Fixed top-level keys on an `*_executed` event payload that flattening must never overwrite. */
const FIXED_EVENT_KEYS = new Set(['proposal_id', 'agent', 'action_type', 'hand', 'path', 'response']);

/** Identifier fields event-driven skills read at the payload top level, used as a body-fallback when the hand's response omits them. */
const BODY_FALLBACK_KEYS = ['slug', 'revision', 'id', 'techpack_id'] as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Best-effort: after a proposal executes successfully, insert `<action_type>_executed`
 * (plus `sourcing_options_executed` for `sourcing_option`) so a downstream agent's
 * urgent poll wakes on the chain, instead of waiting for the daily catch-up. Never
 * emitted for a failed execution, for a row the DB refused to record (a race with a
 * concurrent decision), or for a pure-card `notes` proposal (report/warning/alert/flag).
 * A DB error here is logged and swallowed — it must never fail the execution itself.
 *
 * Event-driven skills read identifiers (`slug`, `revision`, `id`, `techpack_id`, ...) at
 * the event payload's top level, not nested under `response`. So every top-level key of
 * the hand's response whose value is a string, number or boolean is copied onto the event
 * payload's top level too — skipping any key that would overwrite a fixed key above.
 * Nested objects/arrays stay only under `response`. Nothing is flattened when the response
 * was too big and got byte-truncated to a string (`truncateResponseForEvent`), or wasn't an
 * object to begin with. As a further fallback, when `action_payload.body` carries one of
 * `slug`/`revision`/`id`/`techpack_id` and the response lacks it, that value is copied from
 * the body — so a hand that just answers `{ok:true}` still yields a usable event.
 */
function emitExecutedEvent(
  db: Database.Database,
  row: ProposalRow,
  payload: ActionPayload,
  responseBody: unknown,
  deps: ExecutorDeps,
): void {
  if (isSuppressedNotesCard(payload.hand, row.action_type)) return;
  const truncated = truncateResponseForEvent(responseBody);
  const response = payload.hand === 'notes' ? {} : truncated;
  const eventPayload: Record<string, unknown> = {
    proposal_id: row.id,
    agent: row.agent,
    action_type: row.action_type,
    hand: payload.hand,
    path: payload.path,
    response,
  };

  if (isPlainObject(truncated)) {
    for (const [key, value] of Object.entries(truncated)) {
      if (FIXED_EVENT_KEYS.has(key)) continue;
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        eventPayload[key] = value;
      }
    }
  }

  if (isPlainObject(payload.body)) {
    for (const key of BODY_FALLBACK_KEYS) {
      if (FIXED_EVENT_KEYS.has(key) || key in eventPayload) continue;
      const value = payload.body[key];
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        eventPayload[key] = value;
      }
    }
  }

  try {
    insertEvent(db, {
      source_hand: 'spine',
      brand_id: row.brand_id,
      event_type: `${row.action_type}_executed`,
      payload: eventPayload,
      urgent: true,
    }, deps.now());
    if (row.action_type === 'sourcing_option') {
      insertEvent(db, {
        source_hand: 'spine',
        brand_id: row.brand_id,
        event_type: 'sourcing_options_executed',
        payload: eventPayload,
        urgent: true,
      }, deps.now());
    }
  } catch (err) {
    console.error('spine: executed-event emit failed', row.id, err);
  }
}

/**
 * Call the hand named in `action_payload` with the payload verbatim, record
 * the result on the proposal, and never throw. Nothing about the hand's
 * bearer is written to the row.
 */
export async function executeProposal(
  db: Database.Database,
  id: number,
  deps: ExecutorDeps,
): Promise<ExecutionResult> {
  const row = getProposalById(db, id);
  if (!row) return { ok: false, error: `No proposal ${id}` };
  if (!EXECUTABLE.has(row.status)) return { ok: false, error: `Proposal ${id} is ${row.status}` };

  const fail = (error: string): ExecutionResult => {
    const recorded = recordExecution(db, id, 'failed', { error, at: deps.now() });
    return { ok: false, error, recorded };
  };

  let payload: ActionPayload;
  let brand: BrandConfig;
  try {
    payload = JSON.parse(row.action_payload) as ActionPayload;
    brand = deps.loadBrand(row.brand_id);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }

  const invalid = validatePayload(payload);
  if (invalid) return fail(invalid);

  // Built-in "notes" hand: card-only decisions (capacity warnings, schedule
  // changes, ...) that have no hand to call. No HTTP request — the body is
  // the response, recorded like a real hand call would be. A brand may
  // register its own `notes` hand in config to override this.
  if (payload.hand === 'notes' && !Object.hasOwn(brand.hands, 'notes')) {
    const result = { http_status: 200, body: payload.body, at: deps.now() };
    const recorded = recordExecution(db, id, 'executed', result);
    if (recorded) emitExecutedEvent(db, row, payload, payload.body, deps);
    return { ok: true, http_status: 200, body: payload.body, recorded };
  }

  // Built-in "graph" hand: an approved chat dispatch becomes spine events for
  // the Mac mini's urgent poll. No HTTP request — the plan on the body is
  // re-validated and turned into design_request / vendor_contact /
  // run_request_<agent> rows. A brand may register its own `graph` hand in
  // config to override this.
  if (payload.hand === 'graph' && !Object.hasOwn(brand.hands, 'graph')) {
    // Hand name alone is not authority: only `graph_dispatch` may dispatch.
    // Any other action type pointed at this hand — including one an agent
    // promoted to level 3 — fails here with nothing inserted.
    if (row.action_type !== GRAPH_ACTION_TYPE) {
      return fail(`Hand 'graph' only executes action_type '${GRAPH_ACTION_TYPE}', not '${row.action_type}'`);
    }
    const valid = validateGraphPayload(payload, deps.now());
    if (!valid.ok) return fail(valid.error);
    // One transaction over the event inserts AND the status write: a throw
    // mid-loop, or a row another decision already moved, leaves zero events.
    let body: unknown;
    try {
      body = db.transaction(() => {
        const result = runGraphDispatch(db, {
          proposalId: row.id, brandId: row.brand_id, plan: valid.plan, nowIso: deps.now(),
        });
        if (!recordExecution(db, id, 'executed', { http_status: 200, body: result, at: deps.now() })) {
          throw new DispatchNotRecorded();
        }
        return result;
      })();
    } catch (err) {
      if (err instanceof DispatchNotRecorded) {
        return {
          ok: false,
          error: `Proposal ${id} changed status mid-execution; the dispatch was rolled back and no events were inserted`,
          recorded: false,
        };
      }
      return fail(err instanceof Error ? err.message : String(err));
    }
    emitExecutedEvent(db, row, payload, body, deps);
    return { ok: true, http_status: 200, body, recorded: true };
  }

  // Built-in "email" hand: the ONLY way a message leaves Robert's mailbox
  // (spec §12.4). No HTTP route sends mail — a send is always the execution of
  // a proposal that cleared the trust ledger. A brand may register its own
  // `email` hand in config to override this.
  if (payload.hand === 'email' && !Object.hasOwn(brand.hands, 'email')) {
    const valid = validateEmailPayload(payload);
    if (!valid.ok) return fail(valid.error);
    if (!deps.sendEmail) return fail('Email hand is not configured on this instance');
    let sent: EmailHandResult;
    try {
      let evidence: Record<string, unknown> = {};
      try { evidence = JSON.parse(row.evidence) as Record<string, unknown>; } catch { /* evidence is advisory */ }
      sent = await deps.sendEmail({ proposalId: row.id, brandId: row.brand_id, evidence, body: valid.body });
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
    if (!sent.ok) {
      const result = { http_status: sent.http_status ?? 0, body: sent.body ?? sent.error, error: sent.error, at: deps.now() };
      const recorded = recordExecution(db, id, 'failed', result);
      return { ok: false, http_status: sent.http_status, body: sent.body, error: sent.error, recorded };
    }
    const result = { http_status: sent.http_status, body: sent.body, at: deps.now() };
    const recorded = recordExecution(db, id, 'executed', result);
    if (recorded) emitExecutedEvent(db, row, payload, sent.body, deps);
    return { ok: true, http_status: sent.http_status, body: sent.body, recorded };
  }

  let target: { url: string; bearer: string };
  try {
    target = resolveHand(brand, payload.hand, deps.env);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }

  const resolved = resolveHandUrl(target.url, payload.path);
  if (!resolved.ok) return fail(resolved.error);

  try {
    const res = await deps.fetch(resolved.href, {
      method: payload.method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${target.bearer}` },
      body: JSON.stringify(payload.body),
    });
    const text = await res.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* keep text */ }
    const storedText = text.length > STORED_BODY_CAP ? `${text.slice(0, STORED_BODY_CAP)}…[truncated]` : text;
    let storedBody: unknown = storedText;
    try { storedBody = JSON.parse(storedText); } catch { /* keep text */ }
    const result = { http_status: res.status, body: storedBody, at: deps.now() };
    if (res.status >= 200 && res.status < 300) {
      const recorded = recordExecution(db, id, 'executed', result);
      if (recorded) emitExecutedEvent(db, row, payload, body, deps);
      return { ok: true, http_status: res.status, body, recorded };
    }
    const recorded = recordExecution(db, id, 'failed', result);
    return { ok: false, http_status: res.status, body, recorded };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
