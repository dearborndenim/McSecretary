import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import http from 'node:http';
import { initializeSchema } from '../../src/db/schema.js';
import { createSpineRouter, type SpineRouterDeps } from '../../src/spine/api-routes.js';
import { getFinalOutcomes } from '../../src/db/outcome-queries.js';
import { getRun } from '../../src/db/run-index-queries.js';
import { insertEvent } from '../../src/db/event-queries.js';

const NOW = '2026-09-07T12:00:00.000Z';
const KEY = 'k'.repeat(24);

type FakeReq = import('node:http').IncomingMessage & { destroyed: boolean };

function fakeReq(method: string, url: string, body?: unknown, auth?: string, opts: { chunks?: Buffer[] } = {}): FakeReq {
  const chunks = opts.chunks ?? (body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  const listeners: Record<string, ((...a: unknown[]) => void)[]> = {};
  const req = {
    method, url, headers: auth ? { authorization: auth } : {}, destroyed: false,
    on(ev: string, fn: (...a: unknown[]) => void) { (listeners[ev] ??= []).push(fn); return req; },
    destroy() { req.destroyed = true; return req; },
    pause() { return req; },
  };
  queueMicrotask(() => { for (const c of chunks) listeners.data?.forEach((f) => f(c)); listeners.end?.forEach((f) => f()); });
  return req as unknown as FakeReq;
}

function fakeRes() {
  const out = { status: 0, body: '' };
  const res = {
    writeHead(s: number) { out.status = s; return res; },
    end(b?: string, cb?: () => void) { out.body = b ?? ''; cb?.(); },
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
      handFetch: async () => new Response('{}'), env: {},
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

  it('POST /spine/proposals refuses an unknown brand or an unregistered hand', async () => {
    const good = { action_type: 'noop', action_payload: { hand: 'content-engine', method: 'POST', path: '/x', body: {} }, reason: 'r', evidence: {}, cost_usd: 0, reversible: true, level_required: 1, expires_at: '2026-09-09T00:00:00.000Z' };
    let r = fakeRes();
    await handle(fakeReq('POST', '/spine/proposals', { ...good, brand_id: 'no-such-brand' }, `Bearer ${KEY}`), r.res);
    expect(r.out.status).toBe(400);
    expect(JSON.parse(r.out.body).error).toMatch(/Unknown brand/);
    r = fakeRes();
    await handle(fakeReq('POST', '/spine/proposals', { ...good, brand_id: 'dearborn-denim', action_payload: { ...good.action_payload, hand: 'no-such-hand' } }, `Bearer ${KEY}`), r.res);
    expect(r.out.status).toBe(400);
    expect(JSON.parse(r.out.body).error).toMatch(/Unknown hand/);
    expect(filed).toHaveLength(0);
  });

  it('POST /spine/events caps names and slug-checks brand_id', async () => {
    for (const [patch, re] of [
      [{ event_type: 'x'.repeat(129) }, /event_type/],
      [{ source_hand: '' }, /source_hand/],
      [{ brand_id: '../x' }, /brand_id/],
    ] as const) {
      const { res, out } = fakeRes();
      await handle(fakeReq('POST', '/spine/events', { source_hand: 'h', brand_id: 'dearborn-denim', event_type: 'e', payload: {}, urgent: false, ...patch }, `Bearer ${KEY}`), res);
      expect(out.status, JSON.stringify(patch)).toBe(400);
      expect(JSON.parse(out.body).error).toMatch(re);
    }
  });

  it('GET /spine/events/pending counts undrained events per type without draining', async () => {
    const e = (t: string, u: boolean) => ({ source_hand: 'h', brand_id: 'dearborn-denim', event_type: t, payload: {}, urgent: u });
    insertEvent(db, e('po_received', true), NOW);
    insertEvent(db, e('po_received', false), NOW);
    let r = fakeRes();
    await handle(fakeReq('GET', '/spine/events/pending?types=po_received,%20other', undefined, `Bearer ${KEY}`), r.res);
    expect(r.out.status).toBe(200);
    expect(JSON.parse(r.out.body)).toEqual({ counts: { po_received: { pending: 2, urgent: 1 }, other: { pending: 0, urgent: 0 } } });
    r = fakeRes();
    await handle(fakeReq('GET', '/spine/events/pending?types=po_received', undefined, `Bearer ${KEY}`), r.res);
    expect(JSON.parse(r.out.body).counts.po_received.pending).toBe(2);
    r = fakeRes();
    await handle(fakeReq('GET', '/spine/events/pending', undefined, `Bearer ${KEY}`), r.res);
    expect(JSON.parse(r.out.body)).toEqual({ counts: {} });
  });

  it('GET /spine/events/pending rejects oversized type lists with 400', async () => {
    let r = fakeRes();
    await handle(fakeReq('GET', `/spine/events/pending?types=${Array.from({ length: 51 }, (_, i) => `t${i}`).join(',')}`, undefined, `Bearer ${KEY}`), r.res);
    expect(r.out.status).toBe(400);
    r = fakeRes();
    await handle(fakeReq('GET', `/spine/events/pending?types=${'x'.repeat(129)}`, undefined, `Bearer ${KEY}`), r.res);
    expect(r.out.status).toBe(400);
  });

  it('POST /spine/proposals round-trips an optional run_id and rejects an empty one', async () => {
    const proposal = {
      brand_id: 'dearborn-denim', action_type: 'noop',
      action_payload: { hand: 'content-engine', method: 'POST', path: '/x', body: {} },
      reason: 'r', evidence: {}, cost_usd: 0, reversible: true, level_required: 1, expires_at: '2026-09-09T00:00:00.000Z',
    };
    let r = fakeRes();
    await handle(fakeReq('POST', '/spine/proposals', { ...proposal, run_id: 'run-abc' }, `Bearer ${KEY}`), r.res);
    expect(r.out.status).toBe(200);
    expect((filed[0] as { run_id?: string }).run_id).toBe('run-abc');
    r = fakeRes();
    await handle(fakeReq('POST', '/spine/proposals', proposal, `Bearer ${KEY}`), r.res);
    expect(r.out.status).toBe(200);
    expect((filed[1] as { run_id?: string }).run_id).toBeUndefined();
    for (const bad of ['', 'x'.repeat(129), 42]) {
      r = fakeRes();
      await handle(fakeReq('POST', '/spine/proposals', { ...proposal, run_id: bad }, `Bearer ${KEY}`), r.res);
      expect(r.out.status, JSON.stringify(bad)).toBe(400);
      expect(JSON.parse(r.out.body).error).toMatch(/run_id/);
    }
    expect(filed).toHaveLength(2);
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
    expect(JSON.parse(r.out.body).error).toBe('attributes must be a non-empty object');
  });

  it('GET /spine/events/drain answers 500 when a stored payload is corrupt', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      db.prepare("INSERT INTO spine_events (source_hand, brand_id, event_type, payload, urgent, received_at) VALUES ('h','dearborn-denim','po_received','{bad',0,?)").run(NOW);
      const { res, out } = fakeRes();
      await handle(fakeReq('GET', '/spine/events/drain?types=po_received', undefined, `Bearer ${KEY}`), res);
      expect(out.status).toBe(500);
      expect(JSON.parse(out.body)).toEqual({ error: 'Internal error' });
      expect(spy).toHaveBeenCalledOnce();
    } finally {
      spy.mockRestore();
    }
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
    expect(out.body).toBe('{"error":"Unknown brand"}');
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

  it('rejects a body over 64 KB with 413 and destroys the request', async () => {
    const { res, out } = fakeRes();
    const req = fakeReq('POST', '/spine/events', { source_hand: 'h', brand_id: 'b', event_type: 'e', payload: { big: 'x'.repeat(70_000) }, urgent: false }, `Bearer ${KEY}`);
    await handle(req, res);
    expect(out.status).toBe(413);
    expect(req.destroyed).toBe(true);
  });

  it('delivers the 413 to a real client before closing the socket', async () => {
    const server = http.createServer(async (req, res) => {
      if (!(await handle(req, res))) { res.writeHead(404); res.end(); }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as { port: number };
      const body = JSON.stringify({ source_hand: 'h', brand_id: 'b', event_type: 'e', payload: { big: 'x'.repeat(70_000) }, urgent: false });
      const response = await fetch(`http://127.0.0.1:${port}/spine/events`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` }, body,
      });
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ error: 'Body too large' });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('rejects malformed JSON with 400 Invalid JSON', async () => {
    const { res, out } = fakeRes();
    await handle(fakeReq('POST', '/spine/events', undefined, `Bearer ${KEY}`, { chunks: [Buffer.from('{not json')] }), res);
    expect(out.status).toBe(400);
    expect(JSON.parse(out.body)).toEqual({ error: 'Invalid JSON' });
  });

  it('reassembles a multi-byte character split across chunks', async () => {
    const proposal = {
      brand_id: 'dearborn-denim', action_type: 'noop',
      action_payload: { hand: 'content-engine', method: 'POST', path: '/x', body: {} },
      reason: 'fit — best hook', evidence: {}, cost_usd: 0, reversible: true, level_required: 1, expires_at: '2026-09-09T00:00:00.000Z',
    };
    const bytes = Buffer.from(JSON.stringify(proposal), 'utf8');
    const cut = bytes.indexOf(Buffer.from('—', 'utf8')) + 1; // inside the 3-byte em dash
    const { res, out } = fakeRes();
    await handle(fakeReq('POST', '/spine/proposals', undefined, `Bearer ${KEY}`, { chunks: [bytes.subarray(0, cut), bytes.subarray(cut)] }), res);
    expect(out.status).toBe(200);
    expect((filed[0] as { reason: string }).reason).toBe('fit — best hook');
  });

  it('maps an unexpected error to 500 without leaking the message', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const deps: SpineRouterDeps = {
        db, now: () => NOW, agentKeys: new Map([[KEY, 'marketing-manager']]),
        brandsDir: path.join(process.cwd(), 'config', 'brands'),
        file: async () => { throw new Error('db locked'); },
        handFetch: async () => new Response('{}'), env: {},
      };
      const { res, out } = fakeRes();
      await createSpineRouter(deps)(fakeReq('POST', '/spine/proposals', {
        brand_id: 'dearborn-denim', action_type: 'noop',
        action_payload: { hand: 'content-engine', method: 'POST', path: '/x', body: {} },
        reason: 'r', evidence: {}, cost_usd: 0, reversible: true, level_required: 1, expires_at: '2026-09-09T00:00:00.000Z',
      }, `Bearer ${KEY}`), res);
      expect(out.status).toBe(500);
      expect(out.body).not.toContain('db locked');
      expect(JSON.parse(out.body)).toEqual({ error: 'Internal error' });
      expect(spy).toHaveBeenCalledOnce();
    } finally {
      spy.mockRestore();
    }
  });

  it('POST /spine/outcomes rejects bad fields with 400 and writes nothing', async () => {
    const good = { artifact_id: 'cr-1', brand_id: 'dearborn-denim', lane: 'marketing', attributes: { angle: 'fit' }, prediction: null, metrics: { roas: 3 }, observed_at: '2026-09-01T00:00:00.000Z' };
    for (const [patch, re] of [
      [{ artifact_id: '' }, /artifact_id/],
      [{ brand_id: '../x' }, /brand_id/],
      [{ lane: 'finance' }, /lane/],
      [{ attributes: [] }, /attributes/],
      [{ metrics: {} }, /metrics/],
      [{ metrics: { roas: 'high' } }, /metrics/],
      [{ metrics: { roas: Infinity } }, /metrics/], // JSON.stringify turns Infinity into null
      [{ prediction: { roas: 'x' } }, /prediction/],
      [{ prediction: [] }, /prediction/],
      [{ observed_at: 'yesterday' }, /observed_at/],
    ] as const) {
      const { res, out } = fakeRes();
      await handle(fakeReq('POST', '/spine/outcomes', { ...good, ...patch }, `Bearer ${KEY}`), res);
      expect(out.status, JSON.stringify(patch)).toBe(400);
      expect(JSON.parse(out.body).error).toMatch(re);
    }
    expect(getFinalOutcomes(db, 'marketing', '2099-01-01T00:00:00.000Z')).toHaveLength(0);
  });

  it('POST /spine/runs rejects bad fields with 400 and writes nothing', async () => {
    const good = { run_id: 'r1', brand_id: 'dearborn-denim', skill_commit: 'abc', model: 'fable', started_at: NOW, finished_at: null, outcome: 'running', notes: '' };
    for (const [patch, re] of [
      [{ run_id: '' }, /run_id/],
      [{ run_id: 'x'.repeat(129) }, /run_id/],
      [{ brand_id: 'Dearborn Denim' }, /brand_id/],
      [{ skill_commit: 7 }, /skill_commit/],
      [{ model: null }, /model/],
      [{ started_at: 'this morning' }, /started_at/],
      [{ finished_at: 'later' }, /finished_at/],
      [{ outcome: 'meh' }, /outcome/],
      [{ notes: 'n'.repeat(1001) }, /notes/],
      [{ notes: 42 }, /notes/],
    ] as const) {
      const { res, out } = fakeRes();
      await handle(fakeReq('POST', '/spine/runs', { ...good, ...patch }, `Bearer ${KEY}`), res);
      expect(out.status, JSON.stringify(patch)).toBe(400);
      expect(JSON.parse(out.body).error).toMatch(re);
    }
    expect(getRun(db, 'r1')).toBeUndefined();
  });

  it('POST /spine/runs answers 409 when the run_id belongs to another agent', async () => {
    const OTHER = 'f'.repeat(24);
    const deps: SpineRouterDeps = {
      db, now: () => NOW, agentKeys: new Map([[KEY, 'marketing-manager'], [OTHER, 'finance']]),
      brandsDir: path.join(process.cwd(), 'config', 'brands'),
      file: async () => { throw new Error('unused'); },
      handFetch: async () => new Response('{}'), env: {},
    };
    const h = createSpineRouter(deps);
    const run = { run_id: 'r1', brand_id: 'dearborn-denim', skill_commit: 'abc', model: 'fable', started_at: NOW, finished_at: null, outcome: 'running', notes: '' };
    let r = fakeRes();
    await h(fakeReq('POST', '/spine/runs', run, `Bearer ${OTHER}`), r.res);
    expect(r.out.status).toBe(200);
    r = fakeRes();
    await h(fakeReq('POST', '/spine/runs', { ...run, outcome: 'ok' }, `Bearer ${KEY}`), r.res);
    expect(r.out.status).toBe(409);
    expect(JSON.parse(r.out.body)).toEqual({ error: 'run_id belongs to another agent' });
    expect(getRun(db, 'r1')!.agent).toBe('finance');
    expect(getRun(db, 'r1')!.outcome).toBe('running');
  });
});
