import type http from 'node:http';
import type Database from 'better-sqlite3';
import { agentForBearer } from './agent-keys.js';
import { loadBrandConfig, resolveHand } from './brand-config.js';
import { resolveHandUrl } from './executor.js';
import { validateEmailPayload } from './email-hand.js';
import { BodyTooLarge, readBody, readCapped } from '../http-util.js';
import { insertEvent, drainEvents, countPendingByType } from '../db/event-queries.js';
import { insertOutcome } from '../db/outcome-queries.js';
import { upsertRun } from '../db/run-index-queries.js';
import { listTrustRowsForAgent, promoteTrust, getTrustRow } from '../db/trust-queries.js';
import type { Routed } from './router.js';
import type { OutcomeInput, ProposalInput, RunIndexInput, SpineEventInput, TrustLevel } from './types.js';

export interface SpineRouterDeps {
  db: Database.Database;
  now: () => string;
  agentKeys: Map<string, string>;
  brandsDir: string;
  file: (input: ProposalInput) => Promise<{ id: number; routed: Routed }>;
  /** Used only by the read-only hand proxy; the executor has its own fetch. */
  handFetch: (url: string, init: RequestInit) => Promise<Response>;
  env: Record<string, string | undefined>;
}

const MAX_BODY_BYTES = 64 * 1024;
const BRAND_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];
const NAME_MAX = 128;
const MAX_PENDING_TYPES = 50;
const HAND_PROXY_BODY_CAP = 1_048_576;
const NOTES_TITLE_MAX = 120;
const NOTES_SUMMARY_MAX = 2000;
const NOTES_NOTIFY_MAX = 600;
const DEFAULT_BRAND_ID = 'dearborn-denim';
const PROMOTE_FIELDS = ['agent', 'action_type', 'level'];

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function requireFields(obj: Record<string, unknown>, fields: string[]): string | null {
  for (const f of fields) if (!(f in obj)) return `Missing field: ${f}`;
  return null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function isIsoString(v: unknown): v is string {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v));
}

function isFiniteNumberMap(v: unknown): v is Record<string, number> {
  return isPlainObject(v) && Object.values(v).every((n) => typeof n === 'number' && Number.isFinite(n));
}

/** Intake shape check so a bad payload is a 400 here, not a failed execution after Robert approved it. Origin safety is enforced again in the executor (`resolveHandUrl`). */
function validateActionPayload(p: unknown): string | null {
  if (!isPlainObject(p)) return 'action_payload must be an object';
  if (typeof p.hand !== 'string' || !p.hand) return 'action_payload.hand must be a non-empty string';
  if (!METHODS.includes(p.method as string)) return 'action_payload.method must be POST, PUT, PATCH or DELETE';
  if (typeof p.path !== 'string' || !/^\/(?!\/)/.test(p.path) || !/^\/[A-Za-z0-9._~%!$&'()*+,;=:\/-]*$/.test(p.path) || p.path.length > 2048) {
    return "action_payload.path must start with a single '/' and contain only unreserved and sub-delim characters";
  }
  if (!isPlainObject(p.body)) return 'action_payload.body must be an object';
  return null;
}

/**
 * The built-in `notes` hand (card-only decisions with no hand to call): POST
 * to `/note` with a title/summary the executor short-circuits on and the
 * Telegram card renders directly. Only called once validateActionPayload has
 * already confirmed the generic shape.
 */
function validateNotesPayload(p: { method: unknown; path: unknown; body: Record<string, unknown> }): string | null {
  if (p.method !== 'POST') return "action_payload.method must be POST for hand 'notes'";
  if (p.path !== '/note') return "action_payload.path must be '/note' for hand 'notes'";
  const { body } = p;
  if (typeof body.title !== 'string' || body.title.length === 0 || body.title.length > NOTES_TITLE_MAX) {
    return `action_payload.body.title must be a string of 1–${NOTES_TITLE_MAX} chars`;
  }
  if (typeof body.summary !== 'string' || body.summary.length === 0 || body.summary.length > NOTES_SUMMARY_MAX) {
    return `action_payload.body.summary must be a string of 1–${NOTES_SUMMARY_MAX} chars`;
  }
  if (body.notify !== undefined && (typeof body.notify !== 'string' || body.notify.length > NOTES_NOTIFY_MAX)) {
    return `action_payload.body.notify must be a string of at most ${NOTES_NOTIFY_MAX} chars`;
  }
  if (body.details !== undefined && !isPlainObject(body.details)) return 'action_payload.body.details must be an object';
  return null;
}

function validateProposal(b: Record<string, unknown>): string | null {
  if (typeof b.brand_id !== 'string' || !BRAND_ID_RE.test(b.brand_id)) return 'brand_id must be a lowercase slug';
  if (typeof b.action_type !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(b.action_type)) return 'action_type must be a snake_case identifier';
  const shape = validateActionPayload(b.action_payload);
  if (shape) return shape;
  const payload = b.action_payload as { hand: string; method: unknown; path: unknown; body: Record<string, unknown> };
  if (payload.hand === 'notes') {
    const notesBad = validateNotesPayload(payload);
    if (notesBad) return notesBad;
  }
  if (payload.hand === 'email') {
    const emailCheck = validateEmailPayload(payload);
    if (!emailCheck.ok) return emailCheck.error;
  }
  // The `graph` hand starts Designer runs and rewrites the vendor registry.
  // Its only legitimate producer is McSecretary's own chat tool, which files
  // in-process through `spine.file`. No agent bearer may reach it, whatever
  // action_type it names.
  if (payload.hand === 'graph') {
    return "action_payload.hand 'graph' is filed in-process by McSecretary only; it cannot be filed over HTTP";
  }
  if (typeof b.reason !== 'string' || b.reason.length === 0 || b.reason.length > 2000) return 'reason must be a string of 1–2000 chars';
  if (!isPlainObject(b.evidence)) return 'evidence must be an object';
  if (typeof b.cost_usd !== 'number' || !Number.isFinite(b.cost_usd) || b.cost_usd < 0) return 'cost_usd must be a non-negative number';
  if (typeof b.reversible !== 'boolean') return 'reversible must be a boolean';
  if (![0, 1, 2, 3].includes(b.level_required as number)) return 'level_required must be 0, 1, 2 or 3';
  if (!isIsoString(b.expires_at)) return 'expires_at must be an ISO timestamp';
  if (b.run_id !== undefined && b.run_id !== null && (typeof b.run_id !== 'string' || b.run_id.length === 0 || b.run_id.length > NAME_MAX)) return `run_id must be a string of 1–${NAME_MAX} chars`;
  return null;
}

/**
 * The brand must have a config file and the hand must be registered in it, or
 * Robert would approve a card that can only fail. Exceptions: `notes` and
 * `email` are built-in hands available to every brand that hasn't registered
 * its own hand of that name — `notes` never makes an HTTP call and `email`
 * goes out through Microsoft Graph, so neither needs a config entry. The third
 * built-in hand, `graph`, is deliberately NOT an exception here: `validateProposal`
 * refuses it outright on this path.
 */
function validateBrandAndHand(brandsDir: string, brandId: string, hand: string): string | null {
  let brand;
  try { brand = loadBrandConfig(brandsDir, brandId); } catch { return `Unknown brand: ${brandId}`; }
  if ((hand === 'notes' || hand === 'email') && !Object.hasOwn(brand.hands, hand)) return null;
  if (!Object.hasOwn(brand.hands, hand)) return `Unknown hand for ${brandId}: ${hand}`;
  return null;
}

function validateEvent(b: Record<string, unknown>): string | null {
  if (typeof b.source_hand !== 'string' || b.source_hand.length === 0 || b.source_hand.length > NAME_MAX) return `source_hand must be a string of 1–${NAME_MAX} chars`;
  if (typeof b.event_type !== 'string' || b.event_type.length === 0 || b.event_type.length > NAME_MAX) return `event_type must be a string of 1–${NAME_MAX} chars`;
  if (typeof b.brand_id !== 'string' || !BRAND_ID_RE.test(b.brand_id)) return 'brand_id must be a lowercase slug';
  if (!isPlainObject(b.payload)) return 'payload must be an object';
  if (typeof b.urgent !== 'boolean') return 'urgent must be a boolean';
  return null;
}

function validateOutcome(b: Record<string, unknown>): string | null {
  if (typeof b.artifact_id !== 'string' || b.artifact_id.length === 0) return 'artifact_id must be a non-empty string';
  if (typeof b.brand_id !== 'string' || !BRAND_ID_RE.test(b.brand_id)) return 'brand_id must be a lowercase slug';
  if (!LANES.includes(b.lane as string)) return `lane must be one of ${LANES.join('|')}`;
  if (!isPlainObject(b.attributes) || Object.keys(b.attributes).length === 0) return 'attributes must be a non-empty object';
  if (!isFiniteNumberMap(b.metrics) || Object.keys(b.metrics).length === 0) return 'metrics must be a non-empty object of finite numbers';
  if (b.prediction !== undefined && b.prediction !== null && !isFiniteNumberMap(b.prediction)) return 'prediction must be null or an object of finite numbers';
  if (!isIsoString(b.observed_at)) return 'observed_at must be an ISO timestamp';
  return null;
}

function validateRun(b: Record<string, unknown>): string | null {
  if (typeof b.run_id !== 'string' || b.run_id.length === 0 || b.run_id.length > 128) return 'run_id must be a string of 1–128 chars';
  if (typeof b.brand_id !== 'string' || !BRAND_ID_RE.test(b.brand_id)) return 'brand_id must be a lowercase slug';
  if (typeof b.skill_commit !== 'string') return 'skill_commit must be a string';
  if (typeof b.model !== 'string') return 'model must be a string';
  if (!isIsoString(b.started_at)) return 'started_at must be an ISO timestamp';
  if (b.finished_at !== undefined && b.finished_at !== null && !isIsoString(b.finished_at)) return 'finished_at must be null or an ISO timestamp';
  if (!RUN_OUTCOMES.includes(b.outcome as string)) return `outcome must be one of ${RUN_OUTCOMES.join('|')}`;
  if (b.notes !== undefined && (typeof b.notes !== 'string' || b.notes.length > 1000)) return 'notes must be a string of at most 1000 chars';
  return null;
}

function validatePromoteBody(b: Record<string, unknown>): string | null {
  if (typeof b.agent !== 'string' || b.agent.length === 0 || b.agent.length > NAME_MAX) return `agent must be a string of 1–${NAME_MAX} chars`;
  if (typeof b.action_type !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(b.action_type)) return 'action_type must be a snake_case identifier';
  if (!Number.isInteger(b.level) || (b.level as number) < 0 || (b.level as number) > 3) return 'level must be an integer 0–3';
  if (b.brand_id !== undefined && (typeof b.brand_id !== 'string' || !BRAND_ID_RE.test(b.brand_id))) return 'brand_id must be a lowercase slug';
  return null;
}

/** Mirrors the Telegram `promote` command's refusal text (§6 pinned gates). */
function promoteRefusalMessage(actionType: string, reason: 'pinned' | 'out_of_range'): string {
  return reason === 'pinned'
    ? `${actionType} is a pinned human gate and stays at level 1.`
    : 'Level must be 0–3.';
}

/**
 * `/spine/trust/promote` is gated by SPINE_ADMIN_TOKEN, not agent keys — a
 * valid agent bearer must NOT unlock it, so this runs before (and instead of)
 * the agentForBearer check the rest of the router uses.
 */
async function handlePromoteRoute(req: http.IncomingMessage, res: http.ServerResponse, deps: SpineRouterDeps): Promise<true> {
  try {
    const adminToken = deps.env.SPINE_ADMIN_TOKEN;
    if (!adminToken) { json(res, 503, { error: 'SPINE_ADMIN_TOKEN is not configured' }); return true; }
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ') || auth.slice(7) !== adminToken) {
      json(res, 401, { error: 'Unauthorized' });
      return true;
    }
    const parsed = await readObject(req, PROMOTE_FIELDS);
    if ('error' in parsed) { json(res, 400, { error: parsed.error }); return true; }
    const bad = validatePromoteBody(parsed.body);
    if (bad) { json(res, 400, { error: bad }); return true; }
    const brand_id = (parsed.body.brand_id as string | undefined) ?? DEFAULT_BRAND_ID;
    try { loadBrandConfig(deps.brandsDir, brand_id); } catch { json(res, 400, { error: `Unknown brand: ${brand_id}` }); return true; }
    const key = { agent: parsed.body.agent as string, brand_id, action_type: parsed.body.action_type as string };
    const r = promoteTrust(deps.db, key, parsed.body.level as TrustLevel, 'admin-http', deps.now());
    if (!r.ok) { json(res, 400, { error: promoteRefusalMessage(key.action_type, r.reason) }); return true; }
    json(res, 200, getTrustRow(deps.db, key));
    return true;
  } catch (err) {
    if (err instanceof BodyTooLarge) {
      res.writeHead(413, { 'Content-Type': 'application/json', Connection: 'close' });
      res.end(JSON.stringify({ error: 'Body too large' }), () => req.destroy());
      return true;
    }
    console.error('spine route error', err);
    json(res, 500, { error: 'Internal error' });
    return true;
  }
}

const PROPOSAL_FIELDS = ['brand_id', 'action_type', 'action_payload', 'reason', 'evidence', 'cost_usd', 'reversible', 'level_required', 'expires_at'];
const EVENT_FIELDS = ['source_hand', 'brand_id', 'event_type', 'payload', 'urgent'];
const OUTCOME_FIELDS = ['artifact_id', 'brand_id', 'lane', 'attributes', 'metrics', 'observed_at'];
const RUN_FIELDS = ['run_id', 'brand_id', 'skill_commit', 'model', 'started_at', 'outcome'];
const LANES = ['marketing', 'ops', 'product'];
const RUN_OUTCOMES = ['ok', 'nothing_to_do', 'contract_violation', 'hand_error', 'running'];

/** Parse a JSON object body or return the 400 message to send. Only the request body's own parse maps to 400; a SyntaxError from anywhere else is a 500. */
async function readObject(req: http.IncomingMessage, fields: string[]): Promise<{ body: Record<string, unknown> } | { error: string }> {
  const raw = await readBody(req, MAX_BODY_BYTES);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { error: 'Invalid JSON' };
  }
  if (!isPlainObject(body)) return { error: 'Body must be an object' };
  const missing = requireFields(body, fields);
  return missing ? { error: missing } : { body };
}

/**
 * Returns a handler that answers `/spine/*` and returns true, or returns false
 * untouched for any other path so the existing api.ts chain continues.
 */
export function createSpineRouter(deps: SpineRouterDeps) {
  return async function handleSpineRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
    const url = req.url ?? '';
    if (!url.startsWith('/spine/')) return false;

    const [pathname, qs = ''] = url.split('?', 2) as [string, string?];
    const params = new URLSearchParams(qs);

    // Admin-token gated, independent of agent keys — must run before the
    // agentForBearer check below so an agent bearer can never unlock it.
    if (req.method === 'POST' && pathname === '/spine/trust/promote') {
      return handlePromoteRoute(req, res, deps);
    }

    const agent = agentForBearer(deps.agentKeys, req.headers.authorization);
    if (!agent) { json(res, 401, { error: 'Unauthorized' }); return true; }

    try {
      if (req.method === 'POST' && pathname === '/spine/proposals') {
        const parsed = await readObject(req, PROPOSAL_FIELDS);
        if ('error' in parsed) { json(res, 400, { error: parsed.error }); return true; }
        const bad = validateProposal(parsed.body)
          ?? validateBrandAndHand(deps.brandsDir, parsed.body.brand_id as string, (parsed.body.action_payload as { hand: string }).hand);
        if (bad) { json(res, 400, { error: bad }); return true; }
        const input = { ...(parsed.body as unknown as ProposalInput), agent };
        json(res, 200, await deps.file(input));
        return true;
      }

      if (req.method === 'POST' && pathname === '/spine/events') {
        const parsed = await readObject(req, EVENT_FIELDS);
        if ('error' in parsed) { json(res, 400, { error: parsed.error }); return true; }
        const bad = validateEvent(parsed.body);
        if (bad) { json(res, 400, { error: bad }); return true; }
        const id = insertEvent(deps.db, parsed.body as unknown as SpineEventInput, deps.now());
        json(res, 200, { id });
        return true;
      }

      if (req.method === 'GET' && pathname === '/spine/events/drain') {
        const types = (params.get('types') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
        const events = drainEvents(deps.db, agent, types, deps.now())
          .map((e) => ({ ...e, payload: JSON.parse(e.payload) as unknown }));
        json(res, 200, { events });
        return true;
      }

      if (req.method === 'GET' && pathname === '/spine/events/pending') {
        const types = (params.get('types') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
        if (types.length > MAX_PENDING_TYPES || types.some((t) => t.length > NAME_MAX)) {
          json(res, 400, { error: `types must be at most ${MAX_PENDING_TYPES} names of at most ${NAME_MAX} chars` });
          return true;
        }
        json(res, 200, { counts: countPendingByType(deps.db, types) });
        return true;
      }

      if (req.method === 'POST' && pathname === '/spine/outcomes') {
        const parsed = await readObject(req, OUTCOME_FIELDS);
        if ('error' in parsed) { json(res, 400, { error: parsed.error }); return true; }
        const bad = validateOutcome(parsed.body);
        if (bad) { json(res, 400, { error: bad }); return true; }
        const o = parsed.body as unknown as OutcomeInput;
        const id = insertOutcome(deps.db, { ...o, prediction: o.prediction ?? null }, { requireAttributes: true });
        json(res, 200, { id });
        return true;
      }

      if (req.method === 'POST' && pathname === '/spine/runs') {
        const parsed = await readObject(req, RUN_FIELDS);
        if ('error' in parsed) { json(res, 400, { error: parsed.error }); return true; }
        const bad = validateRun(parsed.body);
        if (bad) { json(res, 400, { error: bad }); return true; }
        const r = parsed.body as unknown as RunIndexInput;
        const ok = upsertRun(deps.db, { ...r, agent, finished_at: r.finished_at ?? null, notes: r.notes ?? '' });
        if (!ok) { json(res, 409, { error: 'run_id belongs to another agent' }); return true; }
        json(res, 200, { ok: true });
        return true;
      }

      if (req.method === 'GET' && pathname.startsWith('/spine/brands/')) {
        const brandId = pathname.slice('/spine/brands/'.length);
        let brand;
        try {
          brand = loadBrandConfig(deps.brandsDir, brandId);
        } catch (err) {
          console.error('spine: brand config load failed', brandId, err);
          json(res, 404, { error: 'Unknown brand' });
          return true;
        }
        json(res, 200, brand);
        return true;
      }

      if (req.method === 'GET' && pathname === '/spine/trust') {
        json(res, 200, { rows: listTrustRowsForAgent(deps.db, agent) });
        return true;
      }

      // Read-only proxy so an agent can read a hand's data without holding the hand's bearer.
      if (pathname.startsWith('/spine/hands/')) {
        if (req.method !== 'GET') { json(res, 405, { error: 'Only GET is proxied' }); return true; }
        const rest = pathname.slice('/spine/hands/'.length);
        const slash = rest.indexOf('/');
        const hand = slash === -1 ? rest : rest.slice(0, slash);
        const handPath = slash === -1 ? '/' : rest.slice(slash);
        const brandId = params.get('brand') ?? '';
        params.delete('brand');
        if (!BRAND_ID_RE.test(brandId)) { json(res, 400, { error: 'brand= is required' }); return true; }
        let target: { url: string; bearer: string };
        try {
          const brand = loadBrandConfig(deps.brandsDir, brandId);
          if (!Object.hasOwn(brand.hands, hand)) { json(res, 404, { error: `Unknown hand: ${hand.slice(0, 64)}` }); return true; }
          target = resolveHand(brand, hand, deps.env);
        } catch (err) {
          console.error('spine: hand proxy config', hand, err);
          json(res, 404, { error: 'Unknown brand or hand' });
          return true;
        }
        const resolved = resolveHandUrl(target.url, handPath);
        if (!resolved.ok) { json(res, 400, { error: resolved.error }); return true; }
        const qs = params.toString();
        // No signal here: deps.handFetch owns the timeout (wiring's fetchWithTimeout).
        // params.toString() re-encodes as application/x-www-form-urlencoded (space → '+', literal '+' → '%2B').
        const upstream = await deps.handFetch(`${resolved.href}${qs ? `?${qs}` : ''}`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${target.bearer}`, Accept: 'application/json' },
        });
        if (upstream.status < 200 || upstream.status >= 300) {
          void upstream.body?.cancel().catch(() => {});
          json(res, 502, { error: 'Hand returned an error', hand_status: upstream.status });
          return true;
        }
        const body = await readCapped(upstream, HAND_PROXY_BODY_CAP);
        if (!body.ok) {
          json(res, 502, { error: 'Hand response too large', hand_status: upstream.status });
          return true;
        }
        res.writeHead(200, { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json' });
        res.end(body.text);
        return true;
      }

      json(res, 404, { error: 'Not found' });
      return true;
    } catch (err) {
      if (err instanceof BodyTooLarge) {
        // Flush the 413 before dropping the socket so the client sees it rather than a reset.
        res.writeHead(413, { 'Content-Type': 'application/json', Connection: 'close' });
        res.end(JSON.stringify({ error: 'Body too large' }), () => req.destroy());
        return true;
      }
      console.error('spine route error', err);
      json(res, 500, { error: 'Internal error' });
      return true;
    }
  };
}
