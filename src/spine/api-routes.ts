import type http from 'node:http';
import type Database from 'better-sqlite3';
import { agentForBearer } from './agent-keys.js';
import { loadBrandConfig } from './brand-config.js';
import { insertEvent, drainEvents } from '../db/event-queries.js';
import { insertOutcome } from '../db/outcome-queries.js';
import { upsertRun } from '../db/run-index-queries.js';
import type { Routed } from './router.js';
import type { OutcomeInput, ProposalInput, RunIndexInput, SpineEventInput } from './types.js';

export interface SpineRouterDeps {
  db: Database.Database;
  now: () => string;
  agentKeys: Map<string, string>;
  brandsDir: string;
  file: (input: ProposalInput) => Promise<{ id: number; routed: Routed }>;
}

const MAX_BODY_BYTES = 64 * 1024;
const BRAND_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

class BodyTooLarge extends Error {}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (c: Buffer | string) => {
      size += Buffer.byteLength(c);
      if (size > MAX_BODY_BYTES) { reject(new BodyTooLarge('Body too large')); return; }
      data += c.toString();
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function requireFields(obj: Record<string, unknown>, fields: string[]): string | null {
  for (const f of fields) if (!(f in obj)) return `Missing field: ${f}`;
  return null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
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

function validateProposal(b: Record<string, unknown>): string | null {
  if (typeof b.brand_id !== 'string' || !BRAND_ID_RE.test(b.brand_id)) return 'brand_id must be a lowercase slug';
  if (typeof b.action_type !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(b.action_type)) return 'action_type must be a snake_case identifier';
  const shape = validateActionPayload(b.action_payload);
  if (shape) return shape;
  if (typeof b.reason !== 'string' || b.reason.length === 0 || b.reason.length > 2000) return 'reason must be a string of 1–2000 chars';
  if (!isPlainObject(b.evidence)) return 'evidence must be an object';
  if (typeof b.cost_usd !== 'number' || !Number.isFinite(b.cost_usd) || b.cost_usd < 0) return 'cost_usd must be a non-negative number';
  if (typeof b.reversible !== 'boolean') return 'reversible must be a boolean';
  if (![0, 1, 2, 3].includes(b.level_required as number)) return 'level_required must be 0, 1, 2 or 3';
  if (typeof b.expires_at !== 'string' || Number.isNaN(Date.parse(b.expires_at))) return 'expires_at must be an ISO timestamp';
  return null;
}

const PROPOSAL_FIELDS = ['brand_id', 'action_type', 'action_payload', 'reason', 'evidence', 'cost_usd', 'reversible', 'level_required', 'expires_at'];
const EVENT_FIELDS = ['source_hand', 'brand_id', 'event_type', 'payload', 'urgent'];
const OUTCOME_FIELDS = ['artifact_id', 'brand_id', 'lane', 'attributes', 'metrics', 'observed_at'];
const RUN_FIELDS = ['run_id', 'brand_id', 'skill_commit', 'model', 'started_at', 'outcome'];
const LANES = ['marketing', 'ops', 'product'];
const RUN_OUTCOMES = ['ok', 'nothing_to_do', 'contract_violation', 'hand_error', 'running'];

/**
 * Returns a handler that answers `/spine/*` and returns true, or returns false
 * untouched for any other path so the existing api.ts chain continues.
 */
export function createSpineRouter(deps: SpineRouterDeps) {
  return async function handleSpineRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
    const url = req.url ?? '';
    if (!url.startsWith('/spine/')) return false;

    const agent = agentForBearer(deps.agentKeys, req.headers.authorization);
    if (!agent) { json(res, 401, { error: 'Unauthorized' }); return true; }

    const [pathname, qs = ''] = url.split('?', 2) as [string, string?];
    const params = new URLSearchParams(qs);

    try {
      if (req.method === 'POST' && pathname === '/spine/proposals') {
        const body = JSON.parse(await readBody(req)) as unknown;
        if (!isPlainObject(body)) { json(res, 400, { error: 'Body must be an object' }); return true; }
        const missing = requireFields(body, PROPOSAL_FIELDS) ?? validateProposal(body);
        if (missing) { json(res, 400, { error: missing }); return true; }
        const input = { ...(body as unknown as ProposalInput), agent };
        json(res, 200, await deps.file(input));
        return true;
      }

      if (req.method === 'POST' && pathname === '/spine/events') {
        const body = JSON.parse(await readBody(req)) as unknown;
        if (!isPlainObject(body)) { json(res, 400, { error: 'Body must be an object' }); return true; }
        const missing = requireFields(body, EVENT_FIELDS);
        if (missing) { json(res, 400, { error: missing }); return true; }
        if (typeof body.source_hand !== 'string' || typeof body.event_type !== 'string' || typeof body.brand_id !== 'string' || !isPlainObject(body.payload) || typeof body.urgent !== 'boolean') {
          json(res, 400, { error: 'source_hand, event_type, brand_id must be strings; payload an object; urgent a boolean' }); return true;
        }
        const id = insertEvent(deps.db, body as unknown as SpineEventInput, deps.now());
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

      if (req.method === 'POST' && pathname === '/spine/outcomes') {
        const body = JSON.parse(await readBody(req)) as unknown;
        if (!isPlainObject(body)) { json(res, 400, { error: 'Body must be an object' }); return true; }
        const missing = requireFields(body, OUTCOME_FIELDS);
        if (missing) { json(res, 400, { error: missing }); return true; }
        if (!LANES.includes(body.lane as string) || !isPlainObject(body.attributes) || !isPlainObject(body.metrics) || typeof body.artifact_id !== 'string' || typeof body.brand_id !== 'string') {
          json(res, 400, { error: 'lane must be marketing|ops|product; attributes and metrics objects; artifact_id and brand_id strings' }); return true;
        }
        const o = body as unknown as OutcomeInput;
        const id = insertOutcome(deps.db, { ...o, prediction: o.prediction ?? null }, { requireAttributes: true });
        json(res, 200, { id });
        return true;
      }

      if (req.method === 'POST' && pathname === '/spine/runs') {
        const body = JSON.parse(await readBody(req)) as unknown;
        if (!isPlainObject(body)) { json(res, 400, { error: 'Body must be an object' }); return true; }
        const missing = requireFields(body, RUN_FIELDS);
        if (missing) { json(res, 400, { error: missing }); return true; }
        if (!RUN_OUTCOMES.includes(body.outcome as string)) { json(res, 400, { error: `outcome must be one of ${RUN_OUTCOMES.join('|')}` }); return true; }
        const r = body as unknown as RunIndexInput;
        upsertRun(deps.db, { ...r, agent, finished_at: r.finished_at ?? null, notes: r.notes ?? '' });
        json(res, 200, { ok: true });
        return true;
      }

      if (req.method === 'GET' && pathname.startsWith('/spine/brands/')) {
        const brandId = pathname.slice('/spine/brands/'.length);
        try {
          json(res, 200, loadBrandConfig(deps.brandsDir, brandId));
        } catch (err) {
          json(res, 404, { error: err instanceof Error ? err.message : String(err) });
        }
        return true;
      }

      if (req.method === 'GET' && pathname === '/spine/trust') {
        const rows = deps.db.prepare('SELECT * FROM trust_ledger WHERE agent = ? ORDER BY brand_id, action_type').all(agent);
        json(res, 200, { rows });
        return true;
      }

      json(res, 404, { error: 'Not found' });
      return true;
    } catch (err) {
      if (err instanceof BodyTooLarge) { json(res, 413, { error: 'Body too large' }); return true; }
      json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      return true;
    }
  };
}
