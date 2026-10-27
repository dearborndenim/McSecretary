/**
 * OPERATOR direct actions (spec docs/superpowers/specs/2026-10-27-operator-direct-actions-design.md
 * in the claude_code repo). OPERATOR posts a `grok_action` event with the
 * grok-bots key as source_hand grok-operator; McSecretary answers it now, not
 * through a queue an agent drains:
 *
 *   resolve origin {person, bot} → check groups, bot registration and the
 *   bot's action list → validate params → apply the catalogue `limits`
 *   (25 per SKU on a transfer; a PO receipt is read first and flagged) → call the hand directly → audit
 *   row → `action_result` task on grok_task_chief (+ wake) → for an unknown
 *   action, invalid params or a hand failure, a needs_claude report for the
 *   Chief desk.
 *
 * A write within limits runs with NO approval on this path (Robert,
 * 2026-10-27): it never touches the proposal router or the trust ledger. The
 * Telegram staff path keeps its own levels.
 */

import type Database from 'better-sqlite3';
import { insertEvent } from '../db/event-queries.js';
import crypto from 'node:crypto';
import {
  finishAudit, getAuditByKey, getAuditByRequest, getOriginBot, insertAudit, originBotActions,
} from '../db/operator-queries.js';
import { getUserByEmail, type User } from '../db/user-queries.js';
import { SLUG_RE } from '../spine/agent-policy.js';
import { forwardBrandKey, locationForGid, resolveHand, resolveLocation, type BrandConfig } from '../spine/brand-config.js';
import { PROPOSAL_ID_PLACEHOLDER, resolveHandUrl, withForwardedBrand } from '../spine/executor.js';
import { readHandPath } from '../spine/hand-read.js';
import { cap, isPlainObject as isObj } from '../spine/json-object.js';
import type { SpineEventInput } from '../spine/types.js';
import { operatorView, type OperatorSpec, type StaffAction, type StaffCatalogue } from './catalogue.js';
import {
  bindValues, buildWriteProposal, fillPath, handAvailability, label, refusalDetail, resolveCase, validateParams,
} from './execute.js';
import {
  checkPerSku, checkPoReceipt, findOpenPo, type LimitCheck, type ReceiptLine,
} from './limits.js';
import { KANBAN_PO_LIST_LIMIT, poList, poLookupAnswer } from './po-lookup.js';
import { grantedActionIds } from './tools.js';

export const GROK_ACTION_EVENT = 'grok_action';
/** The only key and source allowed to post one (OPERATOR). */
export const OPERATOR_AGENT = 'grok-bots';
export const OPERATOR_SOURCE_HAND = 'grok-operator';
/** The queue OPERATOR drains; the wake hook for it wakes OPERATOR. */
export const RESULT_QUEUE = 'grok_task_chief';
export const RESULT_KIND = 'action_result';
const SYSTEM_AGENT = 'mcsecretary';
const VIA = 'grok-operator';
const RESULT_CAP = 32_000;
const HAND_RESPONSE_CAP = 4000;
const HAND_TIMEOUT_MS = 20_000;
/**
 * factory-fenix refuses a recount at the Factory unless the body carries
 * `allow_factory_set: true` (Robert, 2026-10-27: OPERATOR only). The Telegram
 * staff path never sends it, so a Telegram recount at the Factory stays refused.
 */
const FACTORY_SET_ACTION = 'store_inventory_set';
const FACTORY_SET_FLAG = 'allow_factory_set';

export type ActionStatus = 'ok' | 'refused' | 'failed';

/** The `args` of an action_result task (spec Flow step 5). */
export interface ActionResult {
  request_id: string;
  origin: { person: string | null; bot: string | null };
  action: string;
  status: ActionStatus;
  result: unknown;
  audit_id: number;
  reason: string | null;
  flag_for_robert?: string[];
}

export interface GrokActionRequest {
  bot: string;
  sent_at: string;
  idempotency_key: string;
  request_id: string;
  origin: unknown;
  action: string;
  params: Record<string, unknown>;
  operator_check?: Record<string, unknown>;
}

export interface GrokActionDeps {
  db: Database.Database;
  now: () => string;
  env: Record<string, string | undefined>;
  loadBrand: (brandId: string) => BrandConfig;
  handFetch: (url: string, init: RequestInit) => Promise<Response>;
  catalogue: () => StaffCatalogue;
  /** The wake hooks (SPINE_WAKE_HOOKS): an in-process event does not fire them by itself. */
  wake?: (eventType: string, eventId: number) => void;
  log?: (msg: string) => void;
}

const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

/** The envelope; origin is checked later so a request without one still gets an answer and an audit row. */
export function parseGrokAction(payload: unknown, sourceHand: string): { ok: true; req: GrokActionRequest } | { ok: false; error: string } {
  if (!isObj(payload)) return { ok: false, error: 'payload must be an object' };
  const slug = sourceHand.startsWith('grok-') ? sourceHand.slice(5) : '';
  if (payload.bot !== slug) return { ok: false, error: `payload.bot must be ${slug || 'the source_hand slug'}` };
  if (typeof payload.sent_at !== 'string' || Number.isNaN(Date.parse(payload.sent_at))) return { ok: false, error: 'sent_at must be an ISO timestamp' };
  if (!str(payload.idempotency_key, 128)) return { ok: false, error: 'idempotency_key must be text of 1-128 chars' };
  if (!str(payload.request_id, 128)) return { ok: false, error: 'request_id must be text of 1-128 chars' };
  if (!str(payload.action, 64)) return { ok: false, error: 'action must be an action id' };
  if (payload.params !== undefined && !isObj(payload.params)) return { ok: false, error: 'params must be an object' };
  if (payload.operator_check !== undefined && !isObj(payload.operator_check)) return { ok: false, error: 'operator_check must be an object' };
  return {
    ok: true,
    req: {
      bot: payload.bot as string,
      sent_at: payload.sent_at,
      idempotency_key: payload.idempotency_key,
      request_id: payload.request_id,
      origin: payload.origin,
      action: payload.action,
      params: (payload.params as Record<string, unknown> | undefined) ?? {},
      operator_check: payload.operator_check as Record<string, unknown> | undefined,
    },
  };
}

/** The task OPERATOR drains on grok_task_chief: the grok-task.js shape, answered by nobody (reply_type null). */
export function actionResultTask(r: ActionResult): Record<string, unknown> {
  return {
    task_id: `action-result-${r.audit_id}`,
    kind: RESULT_KIND,
    args: r,
    notify: false,
    due: null,
    filed_by: SYSTEM_AGENT,
    reply_type: null,
  };
}

function capResult(v: unknown): unknown {
  const s = JSON.stringify(v ?? null) ?? 'null';
  return s.length > RESULT_CAP ? { truncated: true, text: s.slice(0, RESULT_CAP) } : v;
}

function parseBody(text: string): unknown {
  try { return JSON.parse(text); } catch { return text; }
}

/** Why the request needs the Chief desk, or null when OPERATOR's own routing is enough. */
type Escalate = 'invalid_request' | 'unknown_action' | 'invalid_params' | 'hand_failed' | null;

interface Outcome {
  status: ActionStatus;
  reason: string | null;
  result?: unknown;
  flags?: string[];
  limit?: unknown;
  hand_status?: number | null;
  hand_text?: string | null;
  escalate?: Escalate;
  user?: User;
}

const refused = (reason: string, extra: Partial<Outcome> = {}): Outcome => ({ status: 'refused', reason, ...extra });
const failed = (reason: string, extra: Partial<Outcome> = {}): Outcome => ({ status: 'failed', reason, escalate: 'hand_failed', ...extra });

type HandAnswer = { ok: true; status: number; text: string } | { ok: false; error: string };

async function readAction(
  d: GrokActionDeps, action: StaffAction, params: Record<string, unknown>, user: User, brand: BrandConfig,
  extraQuery: [string, string][] = [],
): Promise<HandAnswer> {
  const bound = bindValues(action, user, brand);
  if (!bound.ok) return { ok: false, error: bound.error };
  const values = { ...params, ...bound.values };
  const filled = fillPath(resolveCase(action, values).path, values, 'read');
  if (!filled.ok) return { ok: false, error: filled.error };
  return readPath(d, brand, action.hand, filled.path, [...filled.query, ...extraQuery]);
}

async function readPath(d: GrokActionDeps, brand: BrandConfig, hand: string, path: string, query: [string, string][] = []): Promise<HandAnswer> {
  try {
    const [p, q] = path.split('?', 2) as [string, string | undefined];
    const qs: [string, string][] = q ? [...new URLSearchParams(q).entries(), ...query] : query;
    const r = await readHandPath({ brand, hand, path: p, query: qs, env: d.env, handFetch: d.handFetch, forwardBrand: true });
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, status: r.status, text: r.text };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
  }
}

/** A hand's non-2xx (or no answer) as an outcome: 4xx = the service refused the params, else a failure. */
function handProblem(hand: string, a: HandAnswer, what: string): Outcome {
  if (!a.ok) return failed(`Could not ${what}: ${a.error}.`, { hand_status: null, hand_text: null });
  const body = parseBody(a.text);
  const detail = refusalDetail(body);
  const text = cap(a.text, HAND_RESPONSE_CAP);
  if (a.status >= 400 && a.status < 500) {
    return refused(`The ${label(hand)} refused: ${detail}`, { escalate: 'invalid_params', hand_status: a.status, hand_text: text });
  }
  return failed(`The ${label(hand)} answered ${a.status}: ${detail}`, { hand_status: a.status, hand_text: text });
}

/** Check the action's limits (reading the open PO first for a receipt). ok = may run, with any flags for Robert. */
async function checkLimits(
  d: GrokActionDeps, action: StaffAction, values: Record<string, unknown>, brand: BrandConfig,
): Promise<{ ok: true; check: LimitCheck } | { ok: false; outcome: Outcome }> {
  const l = action.limits;
  if (!l) return { ok: true, check: { ok: true, flags: [], detail: {} } };
  if (l.per_sku) {
    const check = checkPerSku(Number(values.quantity), String(values.sku), l.per_sku);
    return check.ok ? { ok: true, check } : { ok: false, outcome: refused(check.reason, { limit: check }) };
  }
  if (l.po_receipt) {
    const poId = String(values.po_id);
    const a = await readPath(d, brand, action.hand, l.po_receipt.read_path);
    if (!a.ok || a.status < 200 || a.status >= 300) {
      const p = handProblem(action.hand, a, 'read the PO');
      // A network error or 5xx stays `failed` (an outage, for the desk); a 4xx is `refused` (handProblem decides).
      return { ok: false, outcome: { ...p, reason: `${p.reason} Without the open quantities nothing was received.` } };
    }
    const po = findOpenPo(parseBody(a.text), poId);
    if (!po) return { ok: false, outcome: refused(`Vendor PO id ${poId} is not open for receiving (not ordered or partly received). Nothing was received.`) };
    const check = checkPoReceipt(po, values.lines as ReceiptLine[]);
    return check.ok ? { ok: true, check } : { ok: false, outcome: refused(check.reason, { limit: check }) };
  }
  return { ok: false, outcome: refused(`${action.id} has an unknown limit kind.`) };
}

/**
 * The hand's idempotency key for one OPERATOR request: derived from request_id
 * (not the audit row), so a resend that ever reaches a hand replays the hand's
 * stored answer instead of writing again. Sanitised to [A-Za-z0-9._-]; the
 * hash keeps two request_ids that sanitise alike apart. At most 120 chars.
 */
export function handIdempotencyKey(postedBy: string, requestId: string): string {
  const safe = requestId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
  const hash = crypto.createHash('sha256').update(`${postedBy}\n${requestId}`).digest('hex').slice(0, 12);
  return `grok-op-${safe}-${hash}`;
}

/** The write itself, straight to the hand with the hand's bearer, keyed by the OPERATOR request. */
async function runWrite(
  d: GrokActionDeps, action: StaffAction, params: Record<string, unknown>, user: User, brand: BrandConfig,
  req: GrokActionRequest, postedBy: string, extraBody: Record<string, unknown> = {},
): Promise<Outcome> {
  const built = buildWriteProposal(action, params, user, brand, `OPERATOR ${req.request_id} via ${String((req.origin as { bot?: unknown }).bot)}`, d.now());
  if (!built.ok) return refused(built.error, { escalate: 'invalid_params' });
  const payload = built.built.input.action_payload;
  let target: { url: string; bearer: string };
  try { target = resolveHand(brand, payload.hand, d.env); }
  catch (err) { return failed(err instanceof Error ? err.message : String(err)); }
  const resolved = resolveHandUrl(target.url, payload.path);
  if (!resolved.ok) return refused(resolved.error, { escalate: 'invalid_params' });
  const href = withForwardedBrand(resolved.href, forwardBrandKey(brand, payload.hand), user.brand_id);
  const key = handIdempotencyKey(postedBy, req.request_id);
  const body = JSON.stringify({ ...payload.body, ...extraBody }).split(PROPOSAL_ID_PLACEHOLDER).join(key);
  let answer: HandAnswer;
  try {
    const res = await d.handFetch(href, {
      method: payload.method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${target.bearer}` },
      body,
      signal: AbortSignal.timeout(HAND_TIMEOUT_MS),
    });
    answer = { ok: true, status: res.status, text: await res.text() };
  } catch (err) {
    answer = { ok: false, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
  }
  if (!answer.ok || answer.status < 200 || answer.status >= 300) return handProblem(action.hand, answer, `reach the ${label(action.hand)}`);
  return { status: 'ok', reason: null, result: parseBody(answer.text), hand_status: answer.status, hand_text: cap(answer.text, HAND_RESPONSE_CAP) };
}

/** Everything after the envelope: never throws. */
async function decide(d: GrokActionDeps, req: GrokActionRequest, postedBy: string): Promise<Outcome> {
  const o = req.origin;
  if (!isObj(o) || !str(o.person, 200) || !str(o.bot, 64)) {
    return refused('The request has no origin {person, bot}; every request must name the employee and their bot.', { escalate: 'invalid_request' });
  }
  const user = getUserByEmail(d.db, (o.person as string).trim());
  if (!user) return refused(`No staff user has the email ${o.person}.`);
  const reg = SLUG_RE.test(o.bot as string) ? getOriginBot(d.db, o.bot as string) : undefined;
  if (!reg) return refused(`The bot ${o.bot} is not registered in McSecretary; Robert registers each assistant bot to one person.`, { user });
  if (reg.user_id !== user.id) return refused(`The bot ${o.bot} is not registered to ${user.name}; a bot acts only for its own person.`, { user });

  const cat = d.catalogue();
  const found = Object.hasOwn(cat.actions, req.action) ? cat.actions[req.action]! : undefined;
  if (!found) return refused(`${req.action} is not a catalogue action.`, { escalate: 'unknown_action', user });
  if (!found.operator) return refused(`${req.action} is not on the OPERATOR path; it goes to Robert another way.`, { user });
  // Groups only: on this path a location comes from the request, not from a binding on the person's row.
  if (!grantedActionIds(cat, user).includes(found.id)) return refused(`${found.id} is not allowed for ${user.name}'s groups.`, { user });
  if (!originBotActions(reg).includes(found.id)) return refused(`The bot ${o.bot} may not use ${found.id}.`, { user });
  const action = operatorView(found);

  const params = validateParams(action, wholeNumbersAsText(action, req.params));
  if (!params.ok) return refused(`Invalid params: ${params.error}.`, { escalate: 'invalid_params', user });

  let brand: BrandConfig;
  try { brand = d.loadBrand(user.brand_id); }
  catch (err) { return { ...failed(`Cannot load brand ${user.brand_id}: ${err instanceof Error ? err.message : String(err)}`), user }; }
  const unavailable = handAvailability(brand, action.hand, d.env);
  if (unavailable) return { ...failed(unavailable), user };

  const located = resolveLocationParams(found.operator!, params.values, user, brand);
  if (!located.ok) return { ...located.outcome, user };

  if (action.kind === 'read' && found.operator!.answer === 'open_pos') {
    return { ...(await openPoLookup(d, action, params.values, user, brand)), user };
  }

  if (action.kind === 'read') {
    const registry = Object.entries(brand.locations ?? {});
    // Asking for every registered location lets factory-fenix answer for a new store without a code change here.
    const extra: [string, string][] = found.operator!.levels_by_location && registry.length
      ? [['locations', registry.map(([, l]) => l.location_id).join(',')]] : [];
    const a = await readAction(d, action, params.values, user, brand, extra);
    if (!a.ok || a.status < 200 || a.status >= 300) return { ...handProblem(action.hand, a, 'read'), user };
    const body = parseBody(a.text);
    return {
      status: 'ok', reason: null, hand_status: a.status, hand_text: null, user,
      result: found.operator!.levels_by_location ? withLevelsByLocation(body, brand) : body,
    };
  }

  const limit = await checkLimits(d, action, params.values, brand);
  if (!limit.ok) return { ...limit.outcome, user };
  const factorySet = found.id === FACTORY_SET_ACTION && params.values.location === brand.location_id;
  const out = await runWrite(d, action, params.values, user, brand, req, postedBy, factorySet ? { [FACTORY_SET_FLAG]: true } : {});
  return {
    ...out, limit: { ...limit.check, locations: located.named }, user,
    flags: out.status === 'ok' && limit.check.ok ? limit.check.flags : [],
  };
}

/**
 * OPERATOR may send a text param as a JSON number (`{po: 1003}`, `{po_id: 7}`):
 * a whole number becomes its text before validation. Other numbers are left
 * for validateParams to refuse.
 */
export function wholeNumbersAsText(action: StaffAction, input: Record<string, unknown>): Record<string, unknown> {
  const out = { ...input };
  for (const [name, spec] of Object.entries(action.params)) {
    const v = out[name];
    if (spec.type === 'string' && typeof v === 'number' && Number.isSafeInteger(v)) out[name] = String(v);
  }
  return out;
}

/**
 * vendor_po_lookup from OPERATOR: kanban's open-PO list, filtered by `po` /
 * `q` here (src/staff/po-lookup.ts). kanban has a vendor filter but no PO
 * filter and lists at most 200 POs, so when the list is full and `q` is given
 * it is read again with `vendor=q` to reach that vendor's older POs.
 */
async function openPoLookup(
  d: GrokActionDeps, action: StaffAction, values: Record<string, unknown>, user: User, brand: BrandConfig,
): Promise<Outcome> {
  const a = await readAction(d, action, values, user, brand);
  if (!a.ok || a.status < 200 || a.status >= 300) return handProblem(action.hand, a, 'read the open POs');
  const body = parseBody(a.text);
  const f = { po: values.po as string | undefined, q: values.q as string | undefined };
  let vendorBody: unknown;
  if (poList(body).length >= KANBAN_PO_LIST_LIMIT && typeof f.q === 'string' && f.q.trim()) {
    const v = await readAction(d, action, values, user, brand, [['vendor', f.q.trim()]]);
    if (v.ok && v.status >= 200 && v.status < 300) vendorBody = parseBody(v.text);
  }
  return { status: 'ok', reason: null, hand_status: a.status, hand_text: null, result: poLookupAnswer(body, f, vendorBody) };
}

/**
 * Each location param (a key or alias) → that location's gid, in place. An
 * optional one left out takes the person's own location when it is a
 * registered one; otherwise the answer asks which location.
 */
export function resolveLocationParams(
  op: OperatorSpec, values: Record<string, unknown>, user: Pick<User, 'location_id' | 'name'>, brand: BrandConfig,
): { ok: true; named: Record<string, string> } | { ok: false; outcome: Outcome } {
  const named: Record<string, string> = {};
  const known = Object.entries(brand.locations ?? {}).map(([k, l]) => (l.aliases?.length ? `${k} (${l.aliases.join(', ')})` : k)).join(', ');
  for (const p of op.locations) {
    const ref = values[p];
    let hit = typeof ref === 'string' && ref ? resolveLocation(brand, ref) : null;
    if (typeof ref === 'string' && ref && !hit) {
      return { ok: false, outcome: refused(`Unknown location "${ref}". Known locations: ${known || 'none registered'}.`, { escalate: 'invalid_params' }) };
    }
    hit ??= locationForGid(brand, user.location_id);
    if (!hit) return { ok: false, outcome: refused(`Which location? ${user.name} has no registered location of their own; name one of: ${known || 'none registered'}.`) };
    values[p] = hit.location_id;
    named[p] = hit.key;
  }
  const keys = Object.values(named);
  if (op.locations.length === 2 && keys[0] === keys[1]) {
    return { ok: false, outcome: refused(`From and to are both ${keys[0]}; nothing would move.`) };
  }
  return { ok: true, named };
}

/**
 * factory-fenix's lookup answer with `levels_by_location` on every variant,
 * keyed by registry key for every registered location. Its own
 * `levels_by_location` (by gid) wins when present; until it sends one, the
 * Factory and the store come from `levels.factory` / `levels.store` and any
 * other location reads null (not reported).
 */
export function withLevelsByLocation(body: unknown, brand: BrandConfig): unknown {
  if (!isObj(body) || !Array.isArray(body.variants)) return body;
  const registry = Object.entries(brand.locations ?? {});
  const variants = body.variants.map((v) => {
    if (!isObj(v)) return v;
    const byGid = isObj(v.levels_by_location) ? v.levels_by_location : null;
    const levels = isObj(v.levels) ? v.levels : {};
    const out: Record<string, number | null> = {};
    for (const [key, loc] of registry) {
      const own = byGid && Object.hasOwn(byGid, loc.location_id) ? byGid[loc.location_id] : undefined;
      const legacy = loc.location_id === brand.location_id ? levels.factory
        : loc.location_id === brand.store_location_id ? levels.store : undefined;
      const n = own !== undefined ? own : legacy;
      out[key] = typeof n === 'number' ? n : null;
    }
    return { ...v, levels_by_location: out };
  });
  return { ...body, variants, locations: Object.fromEntries(registry.map(([k, l]) => [k, l.name])) };
}

function escalationText(req: GrokActionRequest, r: ActionResult, why: NonNullable<Escalate>): string {
  const ask = {
    invalid_request: 'OPERATOR sent a request McSecretary cannot attribute; fix its request shape (GROK_SPINE.md grok_action).',
    unknown_action: 'OPERATOR asked for an action the catalogue does not have; do the work if it is real, or add a catalogue action if it recurs.',
    invalid_params: 'The params did not validate (in McSecretary or at the service); work out what was meant and do it, or tell OPERATOR what to send.',
    hand_failed: 'The service failed or timed out; investigate, and check whether anything was written before retrying.',
  }[why];
  return cap(`OPERATOR request ${r.request_id} (audit #${r.audit_id}) from ${r.origin.person ?? 'unknown person'} via ${r.origin.bot ?? 'unknown bot'}: ${r.action} ${r.status}: ${r.reason ?? ''} ${ask} Params: ${JSON.stringify(req.params)}`, 1500);
}

/**
 * The needs_claude work order for the Chief desk: a grok_report-shaped event
 * as OPERATOR's (source_hand grok-operator, bot operator) so the desk's answer
 * goes back on OPERATOR's queue, stamped filed_by mcsecretary and inserted
 * in-process (posted_by null), which no HTTP key can produce.
 */
function escalate(d: GrokActionDeps, req: GrokActionRequest, r: ActionResult, why: NonNullable<Escalate>, brandId: string): number {
  const text = escalationText(req, r, why);
  return insertEvent(d.db, {
    source_hand: OPERATOR_SOURCE_HAND,
    brand_id: brandId,
    event_type: 'grok_report',
    urgent: false,
    payload: {
      bot: req.bot,
      sent_at: d.now(),
      idempotency_key: `action-escalation-${r.audit_id}`,
      filed_by: SYSTEM_AGENT,
      title: cap(`needs_claude: OPERATOR ${r.request_id} ${r.action} ${r.status}`, 120),
      summary: cap(text, 2000),
      needs_claude: [text],
      metrics: { audit_id: r.audit_id },
    },
  }, d.now());
}

/** Run a stored request to its answer: decide, audit, post the action_result, wake, escalate. Never throws. */
export async function runGrokAction(d: GrokActionDeps, req: GrokActionRequest, auditId: number, postedBy: string): Promise<ActionResult> {
  let out: Outcome;
  try {
    out = await decide(d, req, postedBy);
  } catch (err) {
    out = failed(`Internal error: ${err instanceof Error ? err.message : String(err)}`);
  }
  const o = isObj(req.origin) ? req.origin : {};
  const flags = out.flags ?? [];
  const result: ActionResult = {
    request_id: req.request_id,
    origin: { person: typeof o.person === 'string' ? o.person : null, bot: typeof o.bot === 'string' ? o.bot : null },
    action: req.action,
    status: out.status,
    result: out.status === 'ok' ? capResult(out.result) : null,
    audit_id: auditId,
    reason: out.reason,
    ...(flags.length ? { flag_for_robert: flags } : {}),
  };
  const brandId = out.user?.brand_id ?? 'dearborn-denim';
  let resultEventId: number | null = null;
  let escalationId: number | null = null;
  try {
    resultEventId = insertEvent(d.db, {
      source_hand: SYSTEM_AGENT, brand_id: brandId, event_type: RESULT_QUEUE, urgent: false, payload: actionResultTask(result),
    }, d.now());
    if (out.escalate) escalationId = escalate(d, req, result, out.escalate, brandId);
  } catch (err) {
    d.log?.(`grok_action #${auditId}: could not post the answer: ${err instanceof Error ? err.message : String(err)}`);
  }
  // After a hand write nothing here may throw: the write happened and the answer is already posted.
  try {
    finishAudit(d.db, auditId, {
      finished_at: d.now(), user_id: out.user?.id ?? null, limit_check: out.limit ?? null,
      hand_status: out.hand_status ?? null, hand_response: out.hand_text ?? null,
      status: out.status, reason: out.reason, flags, result_event_id: resultEventId, escalation_event_id: escalationId,
    });
  } catch (err) {
    d.log?.(`grok_action #${auditId}: could not finish the audit row (${out.status}): ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    if (resultEventId !== null) d.wake?.(RESULT_QUEUE, resultEventId);
  } catch (err) {
    d.log?.(`grok_action #${auditId}: wake failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return result;
}

export interface AcceptAnswer {
  status: number;
  body: Record<string, unknown>;
  /** Resolves when the answer is posted (null for a duplicate or a refused envelope). Tests await it. */
  done: Promise<ActionResult | null>;
}

/**
 * POST /spine/events with event_type grok_action, after the policy, envelope
 * and rate checks: 403/400 for a request this path does not take, a duplicate
 * idempotency_key answers its first request's ids and runs nothing, otherwise
 * the event is stored (drained by mcsecretary at once), the audit row opened,
 * 200 answered and the action run in the background.
 */
export function createGrokActionHandler(d: GrokActionDeps) {
  return function accept(agent: string, event: SpineEventInput): AcceptAnswer {
    const none = Promise.resolve(null);
    if (agent !== OPERATOR_AGENT || event.source_hand !== OPERATOR_SOURCE_HAND) {
      return { status: 403, body: { error: `policy: ${agent} may not post ${GROK_ACTION_EVENT} as ${String(event.source_hand).slice(0, 64)}` }, done: none };
    }
    const parsed = parseGrokAction(event.payload, event.source_hand);
    if (!parsed.ok) return { status: 400, body: { error: `grok_action: ${parsed.error}` }, done: none };
    const req = parsed.req;
    // A repeat is the same idempotency_key, or the same request_id under a new key (a resend).
    const dup = () => {
      const row = getAuditByKey(d.db, req.idempotency_key) ?? getAuditByRequest(d.db, agent, req.request_id);
      return row ? { status: 200, body: { id: row.event_id, audit_id: row.id, duplicate: true, status: row.status }, done: none } : null;
    };
    const seen = dup();
    if (seen) return seen;
    const o = isObj(req.origin) ? req.origin : {};
    let ids: { eventId: number; auditId: number };
    try {
      ids = d.db.transaction(() => {
        const nowIso = d.now();
        const eventId = insertEvent(d.db, event, nowIso, agent);
        d.db.prepare('UPDATE spine_events SET drained_by = ?, drained_at = ? WHERE id = ?').run(SYSTEM_AGENT, nowIso, eventId);
        const auditId = insertAudit(d.db, {
          received_at: nowIso, idempotency_key: req.idempotency_key, request_id: req.request_id, event_id: eventId,
          posted_by: agent, via: VIA,
          person: typeof o.person === 'string' ? cap(o.person, 200) : null,
          origin_bot: typeof o.bot === 'string' ? cap(o.bot, 64) : null,
          action: req.action, params: req.params, operator_check: req.operator_check,
        });
        return { eventId, auditId };
      })();
    } catch (err) {
      // Two posts of one key at once: the UNIQUE index lets one through; the other is the duplicate.
      const again = dup();
      if (again) return again;
      throw err;
    }
    const done = runGrokAction(d, req, ids.auditId, agent);
    return { status: 200, body: { id: ids.eventId, audit_id: ids.auditId }, done };
  };
}
export type GrokActionAccept = ReturnType<typeof createGrokActionHandler>;
