// The cutroom hand and keyed agent (cutroom agent-control spec 2026-10-25 §5.7/§6, claude_code repo):
// cutroom's own queue_release proposal (recorded from cutroom's spine.py) must validate and file under
// the restrictive AGENT_POLICY entry, and a rejection must reach cutroom's drain with a path it parses.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { initializeSchema } from '../../src/db/schema.js';
import { createSpineRouter } from '../../src/spine/api-routes.js';
import { insertProposal } from '../../src/db/proposal-queries.js';
import { rejectProposal } from '../../src/spine/decision-events.js';
import { parseAgentPolicy } from '../../src/spine/agent-policy.js';

const NOW = '2026-10-25T15:00:00.000Z';
const CUTROOM = 'c'.repeat(24);
const FIX = path.join(process.cwd(), 'tests', 'fixtures', 'cutroom');
const read = (f: string): Record<string, unknown> => JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8')) as Record<string, unknown>;
// cutroom's spine.py reads the job id from a drained event's payload.path with this pattern.
const RELEASE_PATH = /^\/api\/queue\/([A-Za-z0-9-]+)\/release$/;

function fakeReq(method: string, url: string, body: unknown, auth: string) {
  const listeners: Record<string, ((...a: unknown[]) => void)[]> = {};
  const req = {
    method, url, headers: { authorization: auth }, destroyed: false,
    on(ev: string, fn: (...a: unknown[]) => void) { (listeners[ev] ??= []).push(fn); return req; },
    destroy() { req.destroyed = true; return req; },
    pause() { return req; },
  };
  queueMicrotask(() => {
    if (body !== undefined) listeners.data?.forEach((f) => f(Buffer.from(JSON.stringify(body))));
    listeners.end?.forEach((f) => f());
  });
  return req as unknown as import('node:http').IncomingMessage;
}

describe('cutroom hand + keyed agent', () => {
  let db: Database.Database;
  let handle: ReturnType<typeof createSpineRouter>;
  let ids: number[];
  beforeEach(() => {
    db = new Database(':memory:'); initializeSchema(db); ids = [];
    const agentKeys = new Map([[CUTROOM, 'cutroom']]);
    handle = createSpineRouter({
      db, now: () => NOW, agentKeys,
      agentPolicy: parseAgentPolicy(JSON.stringify(read('agent-policy.json')), agentKeys.values()),
      brandsDir: path.join(process.cwd(), 'config', 'brands'),
      file: async (input) => { const r = insertProposal(db, input, NOW); ids.push(r.id); return { id: r.id, routed: 'card' }; },
      handFetch: (async () => new Response('{}')) as never, env: {},
    });
  });
  afterEach(() => db.close());

  const call = async (method: string, url: string, body?: unknown) => {
    const out = { status: 0, body: '' };
    const res = {
      writeHead(s: number) { out.status = s; return res; },
      end(b?: string, cb?: () => void) { out.body = b ?? ''; cb?.(); },
    };
    await handle(fakeReq(method, url, body, `Bearer ${CUTROOM}`), res as unknown as import('node:http').ServerResponse);
    return { status: out.status, body: out.body ? JSON.parse(out.body) as Record<string, unknown> : {} };
  };
  const proposal = (): Record<string, unknown> => {
    const { _comment, ...p } = read('queue-release-proposal.json');
    void _comment;
    return p;
  };

  it('files the recorded queue_release proposal for both brands, as agent cutroom', async () => {
    expect(await call('POST', '/spine/proposals', proposal())).toMatchObject({ status: 200 });
    expect(await call('POST', '/spine/proposals', { ...proposal(), brand_id: 'knits' })).toMatchObject({ status: 200 });
    const rows = db.prepare('SELECT agent, brand_id, action_type FROM proposals ORDER BY id').all();
    expect(rows).toEqual([
      { agent: 'cutroom', brand_id: 'dearborn-denim', action_type: 'queue_release' },
      { agent: 'cutroom', brand_id: 'knits', action_type: 'queue_release' },
    ]);
  });

  it('refuses every other verb, hand and event the policy does not grant', async () => {
    const cut = { ...proposal(), action_type: 'cut_order', action_payload: { hand: 'cutroom', method: 'POST', path: '/api/cut-orders', body: {} } };
    expect((await call('POST', '/spine/proposals', cut)).status).toBe(403);
    const otherHand = { ...proposal(), action_payload: { hand: 'design-module', method: 'POST', path: '/api/x', body: {} } };
    expect((await call('POST', '/spine/proposals', otherHand)).status).toBe(403);
    const ev = (event_type: string, source_hand = 'cutroom') => ({ source_hand, brand_id: 'dearborn-denim', event_type, payload: { job_id: 'CJ-10252026-1' }, urgent: true });
    expect((await call('POST', '/spine/events', ev('cut_job_ready'))).status).toBe(200);
    expect((await call('POST', '/spine/events', ev('pattern_landed'))).status).toBe(200);
    expect((await call('POST', '/spine/events', ev('po_received'))).status).toBe(403);
    expect((await call('POST', '/spine/events', ev('cut_job_ready', 'piece-work-scanner'))).status).toBe(403);
    expect((await call('GET', '/spine/events/drain?types=queue_release_expired')).status).toBe(403);
    expect((await call('GET', '/spine/hands/cutroom/api/health')).status).toBe(403);
  });

  it('a rejected release card reaches cutroom\'s drain with a path naming the job', async () => {
    expect((await call('POST', '/spine/proposals', proposal())).status).toBe(200);
    expect(rejectProposal(db, ids[0], 'robert-mcmillan', NOW)).toBe(true);
    const r = await call('GET', '/spine/events/drain?types=queue_release_rejected&brand=dearborn-denim');
    expect(r.status).toBe(200);
    const events = r.body.events as Array<{ payload: { path: string } }>;
    expect(events).toHaveLength(1);
    expect(RELEASE_PATH.exec(events[0].payload.path)?.[1]).toBe('CJ-10252026-1');
  });
});
