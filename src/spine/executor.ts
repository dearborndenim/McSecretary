import type Database from 'better-sqlite3';
import { getProposalById, recordExecution } from '../db/proposal-queries.js';
import { resolveHand, type BrandConfig } from './brand-config.js';
import type { ActionPayload } from './types.js';

export interface ExecutorDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  env: Record<string, string | undefined>;
  loadBrand: (brandId: string) => BrandConfig;
  now: () => string;
}

export type ExecutionResult =
  | { ok: true; http_status: number; body: unknown; recorded?: boolean }
  | { ok: false; http_status?: number; body?: unknown; error?: string; recorded?: boolean };

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
    return { ok: true, http_status: 200, body: payload.body, recorded };
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
      return { ok: true, http_status: res.status, body, recorded };
    }
    const recorded = recordExecution(db, id, 'failed', result);
    return { ok: false, http_status: res.status, body, recorded };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
