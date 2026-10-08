/**
 * Executing a staff action from the chat loop (staff access spec §7.2).
 *
 * The model names an action id and fills its params; everything else — hand,
 * method, path, body, identity-bound values — comes from the catalogue and
 * the caller's users row. A read calls the hand now through the brand's
 * bearer (8 KB cap, /api/integration/ only, like read_hand). A write becomes
 * a spine proposal filed as the user (`agent: user.id`) and routed by the
 * trust ledger like any agent's.
 */

import type Database from 'better-sqlite3';
import { getProposalById } from '../db/proposal-queries.js';
import type { BrandConfig } from '../spine/brand-config.js';
import { extractNotify, resolveHandUrl, PROPOSAL_ID_PLACEHOLDER } from '../spine/executor.js';
import { readHandPath, HAND_READ_PATH_PREFIX } from '../spine/hand-read.js';
import { cap, isPlainObject as isObj } from '../spine/json-object.js';
import type { Routed } from '../spine/router.js';
import type { DedupeMode } from '../db/proposal-queries.js';
import type { ProposalInput } from '../spine/types.js';
import {
  BUILT_IN_HANDS, checkValue, getCatalogue,
  type ParamSpec, type StaffAction, type StaffCatalogue,
} from './catalogue.js';
import { staffActionIdsForUser, unsatisfiedBindings, type StaffUser } from './tools.js';

export const REQUEST_TEXT_CAP = 300;
const EVIDENCE_ARRAY_CAP = 500;
const DETAIL_CAP = 300;
export const WRITES_PER_HOUR = 30;

/** What staff hear a hand called. */
const HAND_LABELS: Record<string, string> = {
  'factory-fenix': 'inventory app',
  'kanban-purchaser': 'purchasing system',
  'purchase-order-receiver': 'customer order system',
  'piece-work-scanner': 'piece-work scanner',
};

function label(hand: string): string {
  return HAND_LABELS[hand] ?? hand;
}

// ── rate limit ───────────────────────────────────────────────

/**
 * Filings per user in a sliding hour, in memory per process (spec §7.2 step
 * 6). It counts filings, not attempts: `allowed` before filing, `record` only
 * once a new row was filed (a duplicate or a refusal costs nothing).
 */
export function createWriteLimiter(limit = WRITES_PER_HOUR, windowMs = 3_600_000) {
  const hits = new Map<string, number[]>();
  const recent = (userId: string, nowMs: number) => {
    const r = (hits.get(userId) ?? []).filter((t) => nowMs - t < windowMs);
    hits.set(userId, r);
    return r;
  };
  return {
    allowed(userId: string, nowMs: number): boolean {
      return recent(userId, nowMs).length < limit;
    },
    record(userId: string, nowMs: number): void {
      recent(userId, nowMs).push(nowMs);
    },
  };
}
export type WriteLimiter = ReturnType<typeof createWriteLimiter>;

// ── params ───────────────────────────────────────────────────

type Values = Record<string, unknown>;

function coerceScalar(spec: ParamSpec, v: unknown): unknown {
  if ((spec.type === 'integer' || spec.type === 'number') && typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) {
    return Number(v.trim());
  }
  if (typeof v === 'string') return v.trim();
  return v;
}

function validateOne(name: string, spec: ParamSpec, raw: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  if (spec.type === 'array') {
    if ((raw === undefined || raw === null) && !spec.required) return { ok: true, value: [] };
    if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: `${name} must be a non-empty list` };
    if (raw.length > spec.max!) return { ok: false, error: `${name} has ${raw.length} entries; at most ${spec.max}` };
    const items: Values[] = [];
    for (const [i, item] of raw.entries()) {
      if (!isObj(item)) return { ok: false, error: `${name}[${i}] must be an object` };
      const out: Values = {};
      for (const [field, fspec] of Object.entries(spec.items!)) {
        const r = validateOne(`${name}[${i}].${field}`, fspec, item[field]);
        if (!r.ok) return r;
        if (r.value !== undefined) out[field] = r.value;
      }
      if (spec.items_require_one_of && !spec.items_require_one_of.some((f) => out[f] !== undefined)) {
        return { ok: false, error: `${name}[${i}] needs one of ${spec.items_require_one_of.join(' or ')}` };
      }
      items.push(out);
    }
    return { ok: true, value: items };
  }
  const v = raw === null ? undefined : coerceScalar(spec, raw);
  if (v === undefined || v === '') {
    if (spec.required) return { ok: false, error: `${name} is required` };
    return { ok: true, value: spec.default };
  }
  const err = checkValue(spec, v);
  return err ? { ok: false, error: `${name} ${err}` } : { ok: true, value: v };
}

/**
 * Check the model's input against the action's params. Keys the action does
 * not declare are dropped, never used — a location or brand in the input
 * cannot reach the payload.
 */
export function validateParams(action: StaffAction, input: unknown): { ok: true; values: Values } | { ok: false; error: string } {
  const fields = isObj(input) ? input : {};
  const values: Values = {};
  for (const [name, spec] of Object.entries(action.params)) {
    const r = validateOne(name, spec, fields[name]);
    if (!r.ok) return r;
    if (r.value !== undefined) values[name] = r.value;
  }
  return { ok: true, values };
}

// ── binding and templating ───────────────────────────────────

export function bindValues(action: StaffAction, user: StaffUser, brand: BrandConfig): { ok: true; values: Values } | { ok: false; error: string } {
  const values: Values = {};
  for (const [name, src] of Object.entries(action.bind)) {
    let v: string | null | undefined;
    switch (src) {
      case 'user.location_id': v = user.location_id; break;
      case 'user.brand_id': v = user.brand_id; break;
      case 'user.id': v = user.id; break;
      case 'user.name': v = user.name; break;
      case 'brand.location_id': v = brand.location_id; break;
      // The executor swaps in the row id just before the hand call.
      case 'proposal.id': v = PROPOSAL_ID_PLACEHOLDER; break;
    }
    if (!v) {
      return {
        ok: false,
        error: src === 'user.location_id'
          ? 'You have no store or location set, so this cannot run. Ask Robert to set your location (/setlocation).'
          : `This action needs ${src}, which is not set; ask Robert.`,
      };
    }
    values[name] = v;
  }
  return { ok: true, values };
}

function textOf(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (Array.isArray(v)) return `${v.length} line${v.length === 1 ? '' : 's'}`;
  return String(v);
}

/** Interpolate `{name}` into display text (summary, note title). */
export function fillText(template: string, values: Values): string {
  return template.replace(/\{([^{}]*)\}/g, (_m, name: string) => textOf(values[name]));
}

const WHOLE_PLACEHOLDER = /^\{([^{}]+)\}$/;

/**
 * Fill a body template. A string that is exactly `{name}` takes the value
 * itself (an integer stays an integer, a list stays a list; absent = key
 * omitted); any other string is interpolated.
 */
export function fillBody(template: unknown, values: Values): unknown {
  if (typeof template === 'string') {
    const whole = WHOLE_PLACEHOLDER.exec(template);
    if (whole) return values[whole[1]!];
    return fillText(template, values);
  }
  if (Array.isArray(template)) return template.map((t) => fillBody(t, values));
  if (isObj(template)) {
    const out: Record<string, unknown> = {};
    for (const [k, t] of Object.entries(template)) {
      const v = fillBody(t, values);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  return template;
}

/**
 * Fill a path template. Path substitutions are URL-encoded, so a value can
 * never add a segment (`/` → %2F, which resolveHandUrl refuses). The query
 * part (after `?`) goes into URLSearchParams; a pair whose value is absent is
 * dropped. A read path must still start with /api/integration/ afterwards.
 */
export function fillPath(
  template: string, values: Values, kind: 'read' | 'write',
): { ok: true; path: string; query: [string, string][] } | { ok: false; error: string } {
  const [pathT, queryT] = template.split('?', 2) as [string, string | undefined];
  let missing: string | null = null;
  let badId: string | null = null;
  const path = pathT.replace(/\{([^{}]*)\}/g, (_m, name: string) => {
    const v = values[name];
    if (v === undefined || v === null || v === '') { missing ??= name; return ''; }
    const text = textOf(v);
    // Path values are ids (vendor PO ids, SKUs): refused rather than encoded
    // when they could name another segment.
    if (/[/\\]/.test(text) || text === '.' || text === '..') { badId ??= `${name} "${cap(text, 60)}"`; return ''; }
    return encodeURIComponent(text);
  });
  if (missing) return { ok: false, error: `${missing} is required` };
  if (badId) return { ok: false, error: `${badId} is not a valid id: slashes and dot-segments are not allowed in ids` };
  if (kind === 'read' && !path.startsWith(HAND_READ_PATH_PREFIX)) return { ok: false, error: `a read may only reach ${HAND_READ_PATH_PREFIX}` };
  if (path.split('/').some((seg) => seg === '.' || seg === '..')) return { ok: false, error: 'that value is not allowed in a path' };
  const check = resolveHandUrl('https://hand.invalid', path);
  if (!check.ok) return { ok: false, error: 'that value is not allowed in a path' };
  const query: [string, string][] = [];
  if (queryT) {
    for (const pair of queryT.split('&')) {
      const eq = pair.indexOf('=');
      const key = eq < 0 ? pair : pair.slice(0, eq);
      const valT = eq < 0 ? '' : pair.slice(eq + 1);
      const whole = WHOLE_PLACEHOLDER.exec(valT);
      if (whole && (values[whole[1]!] === undefined || values[whole[1]!] === '')) continue;
      query.push([key, fillText(valT, values)]);
    }
  }
  return { ok: true, path, query };
}

/** The action with its switch case applied: path/summary replaced, body merged over the base. */
export function resolveCase(action: StaffAction, values: Values): { path: string; body: Record<string, unknown>; summary: string } {
  const c = action.switch ? action.switch.cases[String(values[action.switch.param])] : undefined;
  return {
    path: c?.path ?? action.path!,
    body: { ...(action.body ?? {}), ...(c?.body ?? {}) },
    summary: c?.summary ?? action.summary ?? '',
  };
}

export interface BuiltWrite {
  input: ProposalInput;
  summary: string;
}

/** Build the proposal for a write; pure, so the payload can be checked without filing. */
export function buildWriteProposal(
  action: StaffAction, params: Values, user: StaffUser, brand: BrandConfig, requestText: string, nowIso: string,
): { ok: true; built: BuiltWrite } | { ok: false; error: string } {
  const bound = bindValues(action, user, brand);
  if (!bound.ok) return bound;
  // Bindings last: a bound name can never be overridden by a param of the same name.
  const values = { ...params, ...bound.values };
  const c = resolveCase(action, values);
  const path = fillPath(c.path, values, 'write');
  if (!path.ok) return path;
  const body = fillBody(c.body, values) as Record<string, unknown>;
  const summary = fillText(c.summary, values);
  const cost = typeof action.cost_usd === 'number'
    ? action.cost_usd
    : Number(params[action.cost_usd!.param]) * action.cost_usd!.unit_usd;

  const evidence: ProposalInput['evidence'] = {
    requested_by: user.name,
    request_text: cap(requestText.trim(), REQUEST_TEXT_CAP),
  };
  for (const [k, v] of Object.entries(params)) {
    evidence[k] = Array.isArray(v) ? cap(JSON.stringify(v), EVIDENCE_ARRAY_CAP) : (v as string | number | boolean);
  }
  const reasonParam = typeof params.reason === 'string' && params.reason ? params.reason : null;
  const input: ProposalInput = {
    agent: user.id,
    brand_id: user.brand_id,
    action_type: action.action_type!,
    action_payload: { hand: action.hand, method: action.method as 'POST' | 'PUT' | 'PATCH', path: path.path, body },
    reason: reasonParam ? `${summary}\nReason: ${reasonParam}` : summary,
    evidence,
    cost_usd: cost,
    reversible: action.reversible!,
    level_required: action.level_required!,
    expires_at: new Date(Date.parse(nowIso) + action.expires_hours! * 3_600_000).toISOString(),
  };
  return { ok: true, built: { input, summary } };
}

// ── hand responses ───────────────────────────────────────────

/** One line out of a hand's refusal body: `error`, the candidates to pick from, the SKU class. */
export function refusalDetail(body: unknown, fallback?: string): string {
  if (isObj(body)) {
    const parts: string[] = [];
    if (typeof body.error === 'string') parts.push(body.error);
    if (Array.isArray(body.candidates) && body.candidates.length > 0) {
      const names = body.candidates.slice(0, 8).map((c) => {
        if (typeof c === 'string') return c;
        if (isObj(c)) return String(c.name ?? c.material_name ?? c.sku ?? JSON.stringify(c));
        return String(c);
      });
      parts.push(`candidates: ${names.join('; ')}`);
    }
    if (typeof body.sku_class === 'string') parts.push(`SKU class: ${body.sku_class}`);
    if (parts.length > 0) return cap(parts.join(' — '), DETAIL_CAP);
  }
  if (typeof body === 'string' && body.trim()) return cap(body.trim(), DETAIL_CAP);
  return fallback ? cap(fallback, DETAIL_CAP) : 'no detail given';
}

function handAvailability(brand: BrandConfig, hand: string, env: Record<string, string | undefined>): string | null {
  if (!Object.hasOwn(brand.hands, hand)) {
    return BUILT_IN_HANDS.has(hand) ? null : `That action is not available for ${brand.display_name}; nothing was done.`;
  }
  const ref = brand.hands[hand]!;
  if (!env[ref.url_env] || !env[ref.key_env]) return `The ${label(hand)} is not connected yet, so nothing was done. Robert knows it is coming.`;
  return null;
}

// ── execution ────────────────────────────────────────────────

export interface StaffExecDeps {
  db: Database.Database;
  loadBrand: (brandId: string) => BrandConfig;
  env: Record<string, string | undefined>;
  handFetch: (url: string, init: RequestInit) => Promise<Response>;
  file: (input: ProposalInput, opts?: { dedupe?: DedupeMode }) => Promise<{ id: number; routed: Routed }>;
  now: () => string;
  limiter: WriteLimiter;
}

async function runRead(d: StaffExecDeps, action: StaffAction, params: Values, brand: BrandConfig): Promise<string> {
  const values = { ...params };
  const c = resolveCase(action, values);
  const filled = fillPath(c.path, values, 'read');
  if (!filled.ok) return `Cannot look that up: ${filled.error}.`;
  const r = await readHandPath({
    brand, hand: action.hand, path: filled.path, query: filled.query, env: d.env, handFetch: d.handFetch, forwardBrand: true,
  });
  if (!r.ok) return `Cannot look that up: ${r.error}.`;
  if (r.status === 503) return `The ${label(action.hand)} is busy; try again in a minute.`;
  if (r.status < 200 || r.status >= 300) {
    let body: unknown = r.text;
    try { body = JSON.parse(r.text); } catch { /* keep text */ }
    return `The ${label(action.hand)} answered ${r.status}: ${refusalDetail(body)}`;
  }
  return r.capped;
}

/** HH:MM in the user's own zone (Chicago when unset or unknown). */
function clock(iso: string, timeZone: string | undefined): string {
  const opts = { hour: '2-digit', minute: '2-digit', hour12: false } as const;
  try { return new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: timeZone || 'America/Chicago' }).format(new Date(iso)); }
  catch { return new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: 'America/Chicago' }).format(new Date(iso)); }
}

function replyFor(d: StaffExecDeps, user: StaffUser, id: number, routed: Routed, summary: string): string {
  const row = getProposalById(d.db, id);
  const result = (() => { try { return JSON.parse(row?.execution_result ?? 'null') as { body?: unknown; error?: string } | null; } catch { return null; } })();
  switch (routed) {
    case 'card':
      // An admin decides his own card; nobody needs to tell him.
      return user.role === 'admin'
        ? `Filed #${id}; the card is in your inbox.`
        : `Filed #${id} for Robert's approval. I'll tell you when it's decided.`;
    case 'card_failed':
      return `Filed #${id} for Robert's approval, but the card did not reach him; tell him it is waiting.`;
    case 'executed':
    case 'executed_silent': {
      if (!result) return 'It ran on the hand but the result was not recorded — Robert has been told; check before repeating.';
      return `Done: ${extractNotify(result.body) ?? summary}`;
    }
    case 'execution_failed': {
      const detail = result ? refusalDetail(result.body, result.error) : 'no detail given';
      const hand = row ? (JSON.parse(row.action_payload) as { hand: string }).hand : '';
      return `Filed #${id} but the ${label(hand)} refused: ${detail}. Robert has been told.`;
    }
    case 'deduped': {
      if (!row || row.status === 'pending') {
        return `That's already filed as #${id} and waiting for Robert; nothing new was filed.`;
      }
      return `That exact request ran at ${clock(row.created_at, user.timezone)} (#${id}). If you mean another ${summary}, add a different note (e.g. 'second batch') and ask again.`;
    }
  }
}

/**
 * Run one staff action for `user`. Returns the text handed back to the model
 * as the tool result. Never throws.
 */
export async function executeStaffAction(
  d: StaffExecDeps, cat: StaffCatalogue, user: StaffUser, id: string, input: unknown, requestText: string,
): Promise<string> {
  try {
    const action = Object.hasOwn(cat.actions, id) ? cat.actions[id]! : undefined;
    if (!action) return `Unknown staff action: ${id}.`;
    // Defence in depth: the model only saw this user's actions.
    if (!staffActionIdsForUser(cat, user).includes(id)) {
      return `The action ${id} is not available to you. Nothing was done; ask Robert if you need it.`;
    }
    if (unsatisfiedBindings(action, user).length > 0) {
      return 'You have no store or location set, so this cannot run. Ask Robert to set your location (/setlocation).';
    }
    const params = validateParams(action, input);
    if (!params.ok) return `Not filed: ${params.error}.`;

    let brand: BrandConfig;
    try { brand = d.loadBrand(user.brand_id); }
    catch (err) { return `Not done: cannot load brand ${user.brand_id} (${err instanceof Error ? err.message : String(err)}).`; }

    const unavailable = handAvailability(brand, action.hand, d.env);
    if (unavailable) return unavailable;

    if (action.kind === 'read') return await runRead(d, action, params.values, brand);

    const nowIso = d.now();
    const built = buildWriteProposal(action, params.values, user, brand, requestText, nowIso);
    if (!built.ok) return `Not filed: ${built.error}`;
    if (!d.limiter.allowed(user.id, Date.parse(nowIso))) {
      return `You have filed ${WRITES_PER_HOUR} requests in the last hour, which is the limit; nothing was filed. Try again later or message Robert.`;
    }
    // A duplicate is an identical request still pending or filed in the last
    // 15 minutes (a double send must not run twice); a later repeat files anew.
    const { id: proposalId, routed } = await d.file(built.built.input, { dedupe: 'pending_or_recent' });
    if (routed !== 'deduped') d.limiter.record(user.id, Date.parse(nowIso));
    return replyFor(d, user, proposalId, routed, built.built.summary);
  } catch (err) {
    return `Tool error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ── process wiring (the setGraphDeps pattern) ────────────────

let deps: StaffExecDeps | null = null;

export function setStaffDeps(d: StaffExecDeps | null): void {
  deps = d;
}

export async function executeStaffTool(name: string, input: unknown, user: StaffUser, requestText: string): Promise<string> {
  if (!deps) return 'Staff actions are not configured on this instance.';
  return executeStaffAction(deps, getCatalogue(), user, name, input, requestText);
}
