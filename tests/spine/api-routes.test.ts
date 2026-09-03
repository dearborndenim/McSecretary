import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import { initializeSchema } from '../../src/db/schema.js';
import { createSpineRouter, type SpineRouterDeps } from '../../src/spine/api-routes.js';
import { getFinalOutcomes } from '../../src/db/outcome-queries.js';
import { getRun } from '../../src/db/run-index-queries.js';

const NOW = '2026-09-07T12:00:00.000Z';
const KEY = 'k'.repeat(24);

function fakeReq(method: string, url: string, body?: unknown, auth?: string) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const listeners: Record<string, ((...a: unknown[]) => void)[]> = {};
  const req = {
    method, url, headers: auth ? { authorization: auth } : {},
    on(ev: string, fn: (...a: unknown[]) => void) { (listeners[ev] ??= []).push(fn); return req; },
  };
  queueMicrotask(() => { for (const c of chunks) listeners.data?.forEach((f) => f(c)); listeners.end?.forEach((f) => f()); });
  return req as unknown as import('node:http').IncomingMessage;
}

function fakeRes() {
  const out = { status: 0, body: '' };
  const res = {
    writeHead(s: number) { out.status = s; return res; },
    end(b?: string) { out.body = b ?? ''; },
  };
  return { res: res as unknown as import('node:http').ServerResponse, out };
}

describe('spine routes', () => {
  let db: Database.Database;
  let handle: ReturnType<typeof createSpineRouter>;
  let filed: unknown[];
  beforeEach(() => {
    db = new Database(':memory:'); initializeSchema(db); filed = [];
    const deps: SpineRouterDeps = {
      db, now: () => NOW,
      agentKeys: new Map([[KEY, 'marketing-manager']]),
      brandsDir: path.join(process.cwd(), 'config', 'brands'),
      file: async (input) => { filed.push(input); return { id: 1, routed: 'card' }; },
    };
    handle = createSpineRouter(deps);
  });
  afterEach(() => db.close());

  it('ignores non-spine paths', async () => {
    const { res } = fakeRes();
    expect(await handle(fakeReq('GET', '/health'), res)).toBe(false);
  });

  it('rejects a missing or wrong bearer with 401', async () => {
    const { res, out } = fakeRes();
    expect(await handle(fakeReq('POST', '/spine/proposals', {}, 'Bearer nope'), res)).toBe(true);
    expect(out.status).toBe(401);
  });

  it('POST /spine/proposals forces agent from the key and files', async () => {
    const { res, out } = fakeRes();
    await handle(fakeReq('POST', '/spine/proposals', {
      agent: 'someone-else', brand_id: 'dearborn-denim', action_type: 'creative_request',
      action_payload: { hand: 'content-engine', method: 'POST', path: '/api/briefs', body: { angle: 'fit' } },
      reason: 'r', evidence: {}, cost_usd: 0, reversible: true, level_required: 1, expires_at: '2026-09-09T00:00:00.000Z',
    }, `Bearer ${KEY}`), res);
    expect(out.status).toBe(200);
    expect(JSON.parse(out.body)).toEqual({ id: 1, routed: 'card' });
    expect(filed).toHaveLength(1);
    expect((filed[0] as { agent: string }).agent).toBe('marketing-manager');
  });

  it('POST /spine/proposals validates shape with 400', async () => {
    const { res, out } = fakeRes();
    await handle(fakeReq('POST', '/spine/proposals', { brand_id: 'dearborn-denim' }, `Bearer ${KEY}`), res);
    expect(out.status).toBe(400);
    expect(JSON.parse(out.body).error).toMatch(/action_type/);
  });

  it('POST /spine/proposals rejects a bad action_payload at the door', async () => {
    const good = { brand_id: 'dearborn-denim', action_type: 'noop', reason: 'r', evidence: {}, cost_usd: 0, reversible: true, level_required: 1, expires_at: '2026-09-09T00:00:00.000Z' };
    for (const [payload, re] of [
      [{ hand: 'content-engine', method: 'GET', path: '/x', body: {} }, /method/],
      [{ hand: 'content-engine', method: 'POST', path: '@evil.com/x', body: {} }, /path/],
      [{ hand: 'content-engine', method: 'POST', path: '//evil.com/x', body: {} }, /path/],
      [{ hand: 'content-engine', method: 'POST', path: '/x', body: [] }, /body/],
      [{ hand: '', method: 'POST', path: '/x', body: {} }, /hand/],
    ] as const) {
      const { res, out } = fakeRes();
      await handle(fakeReq('POST', '/spine/proposals', { ...good, action_payload: payload }, `Bearer ${KEY}`), res);
      expect(out.status, JSON.stringify(payload)).toBe(400);
      expect(JSON.parse(out.body).error).toMatch(re);
    }
    expect(filed).toHaveLength(0);
  });

  it('POST /spine/proposals rejects scalar fields of the wrong type or size', async () => {
    const good = { brand_id: 'dearborn-denim', action_type: 'noop', action_payload: { hand: 'content-engine', method: 'POST', path: '/x', body: {} }, reason: 'r', evidence: {}, cost_usd: 0, reversible: true, level_required: 1, expires_at: '2026-09-09T00:00:00.000Z' };
    for (const [patch, re] of [
      [{ cost_usd: 'ten' }, /cost_usd/],
      [{ reversible: 'yes' }, /reversible/],
      [{ level_required: 5 }, /level_required/],
      [{ reason: 'x'.repeat(2001) }, /reason/],
      [{ evidence: [] }, /evidence/],
      [{ brand_id: '../x' }, /brand_id/],
      [{ expires_at: 'soon' }, /expires_at/],
    ] as const) {
      const { res, out } = fakeRes();
      await handle(fakeReq('POST', '/spine/proposals', { ...good, ...patch }, `Bearer ${KEY}`), res);
      expect(out.status, JSON.stringify(patch)).toBe(400);
      expect(JSON.parse(out.body).error).toMatch(re);
    }
    expect(filed).toHaveLength(0);
  });

  it('POST /spine/events then GET /spine/events/drain round-trips', async () => {
    let r = fakeRes();
    await handle(fakeReq('POST', '/spine/events', { source_hand: 'purchase-order-receiver', brand_id: 'dearborn-denim', event_type: 'po_received', payload: { po: 9 }, urgent: true }, `Bearer ${KEY}`), r.res);
    expect(r.out.status).toBe(200);
    r = fakeRes();
    await handle(fakeReq('GET', '/spine/events/drain?types=po_received,other', undefined, `Bearer ${KEY}`), r.res);
    const events = JSON.parse(r.out.body).events;
    expect(events).toHaveLength(1);
    expect(events[0].payload.po).toBe(9);
    expect(events[0].drained_by).toBe('marketing-manager');
  });

  it('POST /spine/outcomes stores with maturity and requires attributes', async () => {
    let r = fakeRes();
    await handle(fakeReq('POST', '/spine/outcomes', { artifact_id: 'cr-1', brand_id: 'dearborn-denim', lane: 'marketing', attributes: { angle: 'fit' }, prediction: null, metrics: { roas: 3 }, observed_at: '2026-09-01T00:00:00.000Z' }, `Bearer ${KEY}`), r.res);
    expect(r.out.status).toBe(200);
    expect(getFinalOutcomes(db, 'marketing', '2026-09-09T00:00:00.000Z')).toHaveLength(1);
    r = fakeRes();
    await handle(fakeReq('POST', '/spine/outcomes', { artifact_id: 'cr-2', brand_id: 'dearborn-denim', lane: 'marketing', attributes: {}, prediction: null, metrics: { roas: 3 }, observed_at: '2026-09-01T00:00:00.000Z' }, `Bearer ${KEY}`), r.res);
    expect(r.out.status).toBe(400);
  });

  it('POST /spine/runs upserts with the agent from the key', async () => {
    const { res, out } = fakeRes();
    await handle(fakeReq('POST', '/spine/runs', { run_id: 'r1', brand_id: 'dearborn-denim', skill_commit: 'abc', model: 'fable', started_at: NOW, finished_at: null, outcome: 'running', notes: '' }, `Bearer ${KEY}`), res);
    expect(out.status).toBe(200);
    expect(getRun(db, 'r1')!.agent).toBe('marketing-manager');
  });

  it('GET /spine/brands/:id serves the brand config without env values', async () => {
    const { res, out } = fakeRes();
    await handle(fakeReq('GET', '/spine/brands/dearborn-denim', undefined, `Bearer ${KEY}`), res);
    expect(out.status).toBe(200);
    const b = JSON.parse(out.body);
    expect(b.brand_id).toBe('dearborn-denim');
    expect(b.hands['ad-manager'].url_env).toBe('AD_MANAGER_URL');
  });

  it('GET /spine/brands/:id 404s unknown brands', async () => {
    const { res, out } = fakeRes();
    await handle(fakeReq('GET', '/spine/brands/nope', undefined, `Bearer ${KEY}`), res);
    expect(out.status).toBe(404);
  });

  it('GET /spine/trust returns the ledger rows for the calling agent', async () => {
    db.prepare("INSERT INTO trust_ledger (agent, brand_id, action_type, level) VALUES ('marketing-manager','dearborn-denim','creative_request',2)").run();
    db.prepare("INSERT INTO trust_ledger (agent, brand_id, action_type, level) VALUES ('finance','dearborn-denim','x',2)").run();
    const { res, out } = fakeRes();
    await handle(fakeReq('GET', '/spine/trust', undefined, `Bearer ${KEY}`), res);
    const rows = JSON.parse(out.body).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].level).toBe(2);
  });

  it('rejects a body over 64 KB with 413 and malformed JSON with 400', async () => {
    let r = fakeRes();
    await handle(fakeReq('POST', '/spine/events', { source_hand: 'h', brand_id: 'b', event_type: 'e', payload: { big: 'x'.repeat(70_000) }, urgent: false }, `Bearer ${KEY}`), r.res);
    expect(r.out.status).toBe(413);
    r = fakeRes();
    const req = fakeReq('POST', '/spine/events', undefined, `Bearer ${KEY}`);
    // emit raw garbage
    (req as unknown as { on: (ev: string, fn: (c: Buffer) => void) => unknown }).on('data', () => {});
    await handle(req, r.res);
    expect(r.out.status).toBe(400);
  });
});
