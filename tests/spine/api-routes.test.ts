import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import http from 'node:http';
import { initializeSchema } from '../../src/db/schema.js';
import { createSpineRouter, type SpineRouterDeps } from '../../src/spine/api-routes.js';
import { getFinalOutcomes } from '../../src/db/outcome-queries.js';
import { getRun } from '../../src/db/run-index-queries.js';
import { insertEvent } from '../../src/db/event-queries.js';
import { getTrustRow } from '../../src/db/trust-queries.js';
import { insertProposal } from '../../src/db/proposal-queries.js';
import type { ProposalInput } from '../../src/spine/types.js';
import { parseAgentPolicy } from '../../src/spine/agent-policy.js';

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

  it('POST /spine/proposals still refuses notes for an unknown brand', async () => {
    const { res, out } = fakeRes();
    await handle(fakeReq('POST', '/spine/proposals', {
      brand_id: 'no-such-brand', action_type: 'capacity_warning',
      action_payload: { hand: 'notes', method: 'POST', path: '/note', body: { title: 't', summary: 's' } },
      reason: 'r', evidence: {}, cost_usd: 0, reversible: true, level_required: 1, expires_at: '2026-09-09T00:00:00.000Z',
    }, `Bearer ${KEY}`), res);
    expect(out.status).toBe(400);
    expect(JSON.parse(out.body).error).toMatch(/Unknown brand/);
    expect(filed).toHaveLength(0);
  });

  it('POST /spine/proposals accepts a notes proposal for a brand with no notes hand registered', async () => {
    const { res, out } = fakeRes();
    await handle(fakeReq('POST', '/spine/proposals', {
      brand_id: 'dearborn-denim', action_type: 'capacity_warning',
      action_payload: { hand: 'notes', method: 'POST', path: '/note', body: { title: 'Line 2 at capacity', summary: 'Utilization hit 92% this week.' } },
      reason: 'r', evidence: {}, cost_usd: 0, reversible: true, level_required: 1, expires_at: '2026-09-09T00:00:00.000Z',
    }, `Bearer ${KEY}`), res);
    expect(out.status).toBe(200);
    expect(filed).toHaveLength(1);
  });

  it('POST /spine/proposals rejects a malformed notes payload', async () => {
    const good = {
      brand_id: 'dearborn-denim', action_type: 'capacity_warning', reason: 'r', evidence: {},
      cost_usd: 0, reversible: true, level_required: 1, expires_at: '2026-09-09T00:00:00.000Z',
    };
    for (const [payload, re] of [
      [{ hand: 'notes', method: 'PUT', path: '/note', body: { title: 't', summary: 's' } }, /method must be POST/],
      [{ hand: 'notes', method: 'POST', path: '/notes', body: { title: 't', summary: 's' } }, /path must be '\/note'/],
      [{ hand: 'notes', method: 'POST', path: '/note', body: { summary: 's' } }, /title/],
      [{ hand: 'notes', method: 'POST', path: '/note', body: { title: '', summary: 's' } }, /title/],
      [{ hand: 'notes', method: 'POST', path: '/note', body: { title: 'x'.repeat(121), summary: 's' } }, /title/],
      [{ hand: 'notes', method: 'POST', path: '/note', body: { title: 't' } }, /summary/],
      [{ hand: 'notes', method: 'POST', path: '/note', body: { title: 't', summary: 'x'.repeat(2001) } }, /summary/],
      [{ hand: 'notes', method: 'POST', path: '/note', body: { title: 't', summary: 's', notify: 'x'.repeat(601) } }, /notify/],
      [{ hand: 'notes', method: 'POST', path: '/note', body: { title: 't', summary: 's', details: 'not an object' } }, /details/],
    ] as const) {
      const { res, out } = fakeRes();
      await handle(fakeReq('POST', '/spine/proposals', { ...good, action_payload: payload }, `Bearer ${KEY}`), res);
      expect(out.status, JSON.stringify(payload)).toBe(400);
      expect(JSON.parse(out.body).error).toMatch(re);
    }
    expect(filed).toHaveLength(0);
  });

  it('POST /spine/proposals accepts a notes proposal with optional notify and details', async () => {
    const { res, out } = fakeRes();
    await handle(fakeReq('POST', '/spine/proposals', {
      brand_id: 'dearborn-denim', action_type: 'restock_flag',
      action_payload: {
        hand: 'notes', method: 'POST', path: '/note',
        body: { title: 'Reorder denim', summary: 'On hand below 30 days of cover.', notify: 'Reorder denim now.', details: { sku: 'DD-1234', on_hand: 40 } },
      },
      reason: 'r', evidence: {}, cost_usd: 0, reversible: true, level_required: 1, expires_at: '2026-09-09T00:00:00.000Z',
    }, `Bearer ${KEY}`), res);
    expect(out.status).toBe(200);
    expect(filed).toHaveLength(1);
  });

  it('POST /spine/proposals accepts an email proposal for a brand with no email hand registered', async () => {
    const { res, out } = fakeRes();
    await handle(fakeReq('POST', '/spine/proposals', {
      brand_id: 'dearborn-denim', action_type: 'rfq_send',
      action_payload: {
        hand: 'email', method: 'POST', path: '/send',
        body: {
          to: 'sales@carr.example',
          subject: '[DD-RFQ-linen-carr-20260910] Fabric request — Dearborn Denim, Spring 27',
          text: 'Please reply with style number, price/yd, weight, width, content, minimum and lead time.',
          attachments: [{ url: 'https://design.example/files/x/linen.png', name: 'linen.png' }],
          rfq_id: 'linen-carr-20260910',
        },
      },
      reason: 'RFQ to Carr Textiles', evidence: { rfq_id: 'linen-carr-20260910', intents: 'fi_1,fi_2' },
      cost_usd: 0, reversible: false, level_required: 1, expires_at: '2026-09-12T00:00:00.000Z',
    }, `Bearer ${KEY}`), res);
    expect(out.status).toBe(200);
    expect(filed).toHaveLength(1);
  });

  it('POST /spine/proposals rejects a malformed email payload at file time', async () => {
    const cases: [unknown, RegExp][] = [
      [{ hand: 'email', method: 'PUT', path: '/send', body: { to: 'a@b.com', subject: 's', text: 't' } }, /method must be POST/],
      [{ hand: 'email', method: 'POST', path: '/hands/email/send', body: { to: 'a@b.com', subject: 's', text: 't' } }, /path must be '\/send'/],
      [{ hand: 'email', method: 'POST', path: '/send', body: { subject: 's', text: 't' } }, /at least one recipient/],
      [{ hand: 'email', method: 'POST', path: '/send', body: { to: 'nope', subject: 's', text: 't' } }, /invalid email address/],
      [{ hand: 'email', method: 'POST', path: '/send', body: { to: 'a@b.com', subject: '', text: 't' } }, /subject/],
      [{ hand: 'email', method: 'POST', path: '/send', body: { to: 'a@b.com', subject: 's' } }, /text/],
      [{ hand: 'email', method: 'POST', path: '/send', body: { to: 'a@b.com', subject: 's', text: 't', attachments: [{ url: 'ftp://x/y', name: 'n' }] } }, /http\(s\) url/],
    ];
    for (const [action_payload, re] of cases) {
      const { res, out } = fakeRes();
      await handle(fakeReq('POST', '/spine/proposals', {
        brand_id: 'dearborn-denim', action_type: 'rfq_send', action_payload,
        reason: 'r', evidence: {}, cost_usd: 0, reversible: false, level_required: 1, expires_at: '2026-09-12T00:00:00.000Z',
      }, `Bearer ${KEY}`), res);
      expect(out.status, JSON.stringify(action_payload)).toBe(400);
      expect(JSON.parse(out.body).error).toMatch(re);
    }
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
    r = fakeRes();
    await handle(fakeReq('POST', '/spine/proposals', { ...proposal, run_id: null }, `Bearer ${KEY}`), r.res);
    expect(r.out.status).toBe(200);
    expect((filed[2] as { run_id?: string | null }).run_id).toBeNull();
    for (const bad of ['', 'x'.repeat(129), 42]) {
      r = fakeRes();
      await handle(fakeReq('POST', '/spine/proposals', { ...proposal, run_id: bad }, `Bearer ${KEY}`), r.res);
      expect(r.out.status, JSON.stringify(bad)).toBe(400);
      expect(JSON.parse(r.out.body).error).toMatch(/run_id/);
    }
    expect(filed).toHaveLength(3);
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

  describe('second brand: knits', () => {
    const note = {
      brand_id: 'knits', action_type: 'noop',
      action_payload: { hand: 'notes', method: 'POST', path: '/note', body: { title: 'smoke', summary: 'loop proof' } },
      reason: 'r', evidence: {}, cost_usd: 0, reversible: true, level_required: 1, expires_at: '2026-09-09T00:00:00.000Z',
    };

    it('files a notes proposal for knits through validateBrandAndHand', async () => {
      const r = fakeRes();
      await handle(fakeReq('POST', '/spine/proposals', note, `Bearer ${KEY}`), r.res);
      expect(r.out.status).toBe(200);
      expect(filed).toHaveLength(1);
      expect((filed[0] as { brand_id: string }).brand_id).toBe('knits');
    });

    it('refuses a hand knits does not register, with the existing unknown-hand error', async () => {
      const r = fakeRes();
      await handle(fakeReq('POST', '/spine/proposals', { ...note, action_payload: { hand: 'shopify', method: 'POST', path: '/x', body: {} } }, `Bearer ${KEY}`), r.res);
      expect(r.out.status).toBe(400);
      expect(JSON.parse(r.out.body)).toEqual({ error: 'Unknown hand for knits: shopify' });
      expect(filed).toHaveLength(0);
    });

    it('serves the knits brand file on /spine/brands/knits', async () => {
      const r = fakeRes();
      await handle(fakeReq('GET', '/spine/brands/knits', undefined, `Bearer ${KEY}`), r.res);
      expect(r.out.status).toBe(200);
      expect(JSON.parse(r.out.body)).toMatchObject({ brand_id: 'knits', display_name: 'Ballow' });
    });
  });

  describe('brand= on /spine/events/drain and /spine/events/pending', () => {
    const e = (brand_id: string, urgent: boolean) => ({ source_hand: 'spine', brand_id, event_type: 'design_request', payload: { b: brand_id }, urgent });
    const get = async (url: string) => {
      const r = fakeRes();
      await handle(fakeReq('GET', url, undefined, `Bearer ${KEY}`), r.res);
      return { status: r.out.status, body: JSON.parse(r.out.body) as Record<string, unknown> };
    };
    beforeEach(() => {
      insertEvent(db, e('dearborn-denim', true), NOW);
      insertEvent(db, e('knits', true), NOW);
      insertEvent(db, e('knits', false), NOW);
    });

    it('pending counts per brand, and across brands without brand=', async () => {
      expect((await get('/spine/events/pending?types=design_request&brand=knits')).body)
        .toEqual({ counts: { design_request: { pending: 2, urgent: 1 } } });
      expect((await get('/spine/events/pending?types=design_request&brand=dearborn-denim')).body)
        .toEqual({ counts: { design_request: { pending: 1, urgent: 1 } } });
      expect((await get('/spine/events/pending?types=design_request&brand=no-events')).body)
        .toEqual({ counts: { design_request: { pending: 0, urgent: 0 } } });
      expect((await get('/spine/events/pending?types=design_request')).body)
        .toEqual({ counts: { design_request: { pending: 3, urgent: 2 } } });
    });

    it('each brand drains only its own events; the other brand is left for its own run', async () => {
      const knits = (await get('/spine/events/drain?types=design_request&brand=knits')).body.events as { brand_id: string }[];
      expect(knits.map((x) => x.brand_id)).toEqual(['knits', 'knits']);
      expect((await get('/spine/events/drain?types=design_request&brand=knits')).body.events).toEqual([]);
      const dd = (await get('/spine/events/drain?types=design_request&brand=dearborn-denim')).body.events as { brand_id: string }[];
      expect(dd.map((x) => x.brand_id)).toEqual(['dearborn-denim']);
    });

    it('a drain without brand= takes every brand (a kit that predates per-brand drains)', async () => {
      const all = (await get('/spine/events/drain?types=design_request')).body.events as { brand_id: string }[];
      expect(all.map((x) => x.brand_id)).toEqual(['dearborn-denim', 'knits', 'knits']);
    });

    it.each(['', 'Knits', '../x', 'a%20b', 'knits&brand=dearborn-denim'])('rejects brand=%s with 400 and drains nothing', async (bad) => {
      const d = await get(`/spine/events/drain?types=design_request&brand=${bad}`);
      expect(d.status).toBe(400);
      expect(d.body.error).toBe('brand must be a lowercase slug');
      const p = await get(`/spine/events/pending?types=design_request&brand=${bad}`);
      expect(p.status).toBe(400);
      expect((await get('/spine/events/pending?types=design_request')).body)
        .toEqual({ counts: { design_request: { pending: 3, urgent: 2 } } });
    });
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

  describe('brand registry: GET /spine/brands and /spine/brands/<slug>', () => {
    const ADMIN_TOKEN = 'a'.repeat(20);
    const PUBLIC_KEYS = [
      'active', 'ad_accounts', 'brand_id', 'currency', 'display_name', 'esp_lists', 'features',
      'location_id', 'meta_ad_account', 'primary_domain', 'quickbooks_class', 'shopify_store', 'timezone',
    ];
    const withAdmin = () => createSpineRouter({
      db, now: () => NOW, agentKeys: new Map([[KEY, 'marketing-manager']]),
      brandsDir: path.join(process.cwd(), 'config', 'brands'),
      file: async () => ({ id: 1, routed: 'card' as const }), handFetch: async () => new Response('{}'),
      env: { SPINE_ADMIN_TOKEN: ADMIN_TOKEN },
    });
    const get = async (h: ReturnType<typeof createSpineRouter>, url: string, auth?: string) => {
      const r = fakeRes();
      await h(fakeReq('GET', url, undefined, auth), r.res);
      return r.out;
    };

    it('requires an agent key or the admin token', async () => {
      const h = withAdmin();
      for (const url of ['/spine/brands', '/spine/brands/dearborn-denim']) {
        expect((await get(h, url)).status).toBe(401);
        expect((await get(h, url, 'Bearer wrong-token-xxxxxxxx')).status).toBe(401);
        expect((await get(h, url, `Bearer ${KEY}`)).status).toBe(200);
        expect((await get(h, url, `Bearer ${ADMIN_TOKEN}`)).status).toBe(200);
      }
      // With SPINE_ADMIN_TOKEN unset, an empty bearer must not match it.
      expect((await get(handle, '/spine/brands', 'Bearer ')).status).toBe(401);
    });

    it('lists both brand files with active', async () => {
      const out = await get(handle, '/spine/brands', `Bearer ${KEY}`);
      expect(JSON.parse(out.body)).toEqual({ brands: [
        { brand_id: 'dearborn-denim', active: true },
        { brand_id: 'knits', active: true },
      ] });
    });

    it('serves only identity and settings, never hands, env names or trust settings', async () => {
      for (const [slug, name, store] of [
        ['dearborn-denim', 'Dearborn Denim', 'dearborn-denim-apparel.myshopify.com'],
        ['knits', 'Ballow', 'a5n0dr-bt.myshopify.com'],
      ]) {
        const out = await get(handle, `/spine/brands/${slug}`, `Bearer ${KEY}`);
        expect(out.status).toBe(200);
        const b = JSON.parse(out.body) as Record<string, unknown>;
        expect(Object.keys(b).sort()).toEqual(PUBLIC_KEYS);
        expect(b).toMatchObject({ brand_id: slug, display_name: name, shopify_store: store, active: true });
        expect(out.body).not.toMatch(/_env|_URL|_KEY|hands|inbox_user_id|silent_budget/);
      }
    });

    it('404s an unknown or malformed slug', async () => {
      for (const url of ['/spine/brands/nope', '/spine/brands/', '/spine/brands/../dearborn-denim']) {
        const out = await get(handle, url, `Bearer ${KEY}`);
        expect(out.status).toBe(404);
        expect(out.body).toBe('{"error":"Unknown brand"}');
      }
    });
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

  describe('POST /spine/trust/promote', () => {
    const ADMIN_TOKEN = 't'.repeat(20);
    function handlerWithToken(token?: string) {
      const deps: SpineRouterDeps = {
        db, now: () => NOW, agentKeys: new Map([[KEY, 'marketing-manager']]),
        brandsDir: path.join(process.cwd(), 'config', 'brands'),
        file: async () => { throw new Error('unused'); },
        handFetch: async () => new Response('{}'),
        env: token ? { SPINE_ADMIN_TOKEN: token } : {},
      };
      return createSpineRouter(deps);
    }

    it('answers 503 when SPINE_ADMIN_TOKEN is not configured', async () => {
      const h = handlerWithToken(undefined);
      const { res, out } = fakeRes();
      await h(fakeReq('POST', '/spine/trust/promote', { agent: 'a', action_type: 'x', level: 2 }, `Bearer ${ADMIN_TOKEN}`), res);
      expect(out.status).toBe(503);
    });

    it('answers 401 on a missing or wrong bearer, and a valid agent key does not unlock it', async () => {
      const h = handlerWithToken(ADMIN_TOKEN);
      for (const auth of [undefined, 'Bearer nope', `Bearer ${KEY}`]) {
        const { res, out } = fakeRes();
        await h(fakeReq('POST', '/spine/trust/promote', { agent: 'a', action_type: 'x', level: 2 }, auth), res);
        expect(out.status, String(auth)).toBe(401);
      }
    });

    it('promotes and returns the ledger row, defaulting brand_id to dearborn-denim', async () => {
      const h = handlerWithToken(ADMIN_TOKEN);
      const { res, out } = fakeRes();
      await h(fakeReq('POST', '/spine/trust/promote', { agent: 'marketing-manager', action_type: 'creative_request', level: 2 }, `Bearer ${ADMIN_TOKEN}`), res);
      expect(out.status).toBe(200);
      expect(JSON.parse(out.body)).toMatchObject({ agent: 'marketing-manager', brand_id: 'dearborn-denim', action_type: 'creative_request', level: 2 });
    });

    it('accepts an explicit brand_id and rejects an unknown one', async () => {
      const h = handlerWithToken(ADMIN_TOKEN);
      let r = fakeRes();
      await h(fakeReq('POST', '/spine/trust/promote', { agent: 'a', action_type: 'x', level: 1, brand_id: 'dearborn-denim' }, `Bearer ${ADMIN_TOKEN}`), r.res);
      expect(r.out.status).toBe(200);
      r = fakeRes();
      await h(fakeReq('POST', '/spine/trust/promote', { agent: 'a', action_type: 'x', level: 1, brand_id: 'nope' }, `Bearer ${ADMIN_TOKEN}`), r.res);
      expect(r.out.status).toBe(400);
      expect(JSON.parse(r.out.body).error).toMatch(/Unknown brand/);
    });

    it('refuses to promote a pinned action above level 1, and writes nothing', async () => {
      const h = handlerWithToken(ADMIN_TOKEN);
      const { res, out } = fakeRes();
      await h(fakeReq('POST', '/spine/trust/promote', { agent: 'a', action_type: 'ad_launch', level: 2 }, `Bearer ${ADMIN_TOKEN}`), res);
      expect(out.status).toBe(400);
      expect(JSON.parse(out.body).error).toMatch(/pinned/);
      expect(getTrustRow(db, { agent: 'a', brand_id: 'dearborn-denim', action_type: 'ad_launch' })).toBeUndefined();
    });

    it('rejects an out-of-range level and a malformed body', async () => {
      const h = handlerWithToken(ADMIN_TOKEN);
      let r = fakeRes();
      await h(fakeReq('POST', '/spine/trust/promote', { agent: 'a', action_type: 'x', level: 5 }, `Bearer ${ADMIN_TOKEN}`), r.res);
      expect(r.out.status).toBe(400);
      r = fakeRes();
      await h(fakeReq('POST', '/spine/trust/promote', { agent: '', action_type: 'x', level: 2 }, `Bearer ${ADMIN_TOKEN}`), r.res);
      expect(r.out.status).toBe(400);
    });
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

  it('refuses hand "graph" over HTTP whatever the action_type, so no agent bearer can dispatch', async () => {
    const plan = {
      summary: 'sneaky', briefs: [], vendor_contacts: [{ vendor_name: 'X' }], run_requests: [],
    };
    for (const action_type of ['graph_dispatch', 'costing_report']) {
      const { res, out } = fakeRes();
      await handle(fakeReq('POST', '/spine/proposals', {
        brand_id: 'dearborn-denim', action_type,
        action_payload: { hand: 'graph', method: 'POST', path: '/dispatch', body: plan },
        reason: 'r', evidence: {}, cost_usd: 0, reversible: false, level_required: 1,
        expires_at: '2026-09-09T12:00:00.000Z',
      }, `Bearer ${KEY}`), res);
      expect(out.status, action_type).toBe(400);
      expect(out.body).toContain('in-process');
    }
    expect(filed).toEqual([]);
  });
});

describe('agent policy', () => {
  const BOTS = 'b'.repeat(24);
  const INBOX = 'i'.repeat(24);
  const TASK = 'q'.repeat(24);
  // Spec §7 verbatim, except events_per_hour: 3 and proposals_per_hour: 2 so the caps are testable.
  const POLICY_JSON = `{
  "grok-bots":  { "propose": { "hands": ["notes"], "action_types": ["grok_lead", "grok_signal", "grok_report", "grok_cs_case"] },
                  "events":  { "post_types": ["grok_research", "grok_draft", "grok_sent", "grok_lead", "grok_cs_case", "grok_result", "grok_report", "grok_profile", "grok_daily"], "source_hand": "grok-*", "drain_types": ["grok_task_*"] },
                  "hands_proxy": false, "outcomes": false, "rate": { "events_per_hour": 3, "proposals_per_hour": 2 } },
  "grok-inbox": { "events": { "drain_types": ["grok_research", "grok_draft", "grok_sent", "grok_lead", "grok_cs_case", "grok_result", "grok_report", "grok_profile", "grok_daily"], "post_types": [] },
                  "propose": { "hands": ["notes"], "action_types": ["grok_lead", "grok_cs_case", "grok_result", "grok_drafts_waiting", "grok_inbox_rejects"] }, "hands_proxy": false },
  "grok-task":  { "events": { "post_types": ["grok_task_*"], "source_hand": "self", "drain_types": [] }, "propose": null, "hands_proxy": false }
}`;
  const note = (action_type: string, hand = 'notes', title = 't') => ({
    brand_id: 'dearborn-denim', action_type,
    action_payload: { hand, method: 'POST', path: hand === 'notes' ? '/note' : '/send', body: { title, summary: 's' } },
    reason: 'r', evidence: {}, cost_usd: 0, reversible: true, level_required: 1, expires_at: '2026-09-09T00:00:00.000Z',
  });
  const ev = (event_type: string, source_hand: string) => ({ source_hand, brand_id: 'dearborn-denim', event_type, payload: {}, urgent: false });

  let db: Database.Database;
  let handle: ReturnType<typeof createSpineRouter>;
  let filed: Array<{ agent: string }>;
  let handFetch: ReturnType<typeof vi.fn>;
  let policy: ReturnType<typeof parseAgentPolicy>;
  beforeEach(() => {
    db = new Database(':memory:'); initializeSchema(db); filed = [];
    handFetch = vi.fn(async () => new Response('{}'));
    const agentKeys = new Map([[KEY, 'marketing-manager'], [BOTS, 'grok-bots'], [INBOX, 'grok-inbox'], [TASK, 'grok-task']]);
    policy = parseAgentPolicy(POLICY_JSON, agentKeys.values());
    handle = createSpineRouter({
      db, now: () => NOW, agentKeys, agentPolicy: policy,
      brandsDir: path.join(process.cwd(), 'config', 'brands'),
      // Inserts like the real router so the proposal cap has rows to count.
      file: async (input) => { insertProposal(db, input, NOW); filed.push(input as unknown as { agent: string }); return { id: 1, routed: 'card' }; },
      handFetch: handFetch as unknown as SpineRouterDeps['handFetch'], env: {},
    });
  });
  afterEach(() => db.close());

  const call = async (method: string, url: string, key?: string, body?: unknown) => {
    const r = fakeRes();
    await handle(fakeReq(method, url, body, key ? `Bearer ${key}` : undefined), r.res);
    return { status: r.out.status, body: r.out.body ? JSON.parse(r.out.body) as Record<string, unknown> : {} };
  };
  const eventCount = () => (db.prepare('SELECT COUNT(*) AS n FROM spine_events').get() as { n: number }).n;
  const undrained = (t: string) => (db.prepare('SELECT COUNT(*) AS n FROM spine_events WHERE event_type = ? AND drained_at IS NULL').get(t) as { n: number }).n;

  it('grok-bots may file a notes grok_lead card and nothing else', async () => {
    expect((await call('POST', '/spine/proposals', BOTS, note('grok_lead'))).status).toBe(200);
    expect(filed).toEqual([expect.objectContaining({ agent: 'grok-bots' })]);
    const email = await call('POST', '/spine/proposals', BOTS, note('grok_lead', 'email'));
    expect(email.status).toBe(403);
    expect(email.body).toEqual({ error: 'policy: grok-bots may not propose grok_lead on email' });
    expect((await call('POST', '/spine/proposals', BOTS, note('rfq_send'))).status).toBe(403);
    expect(filed).toHaveLength(1);
  });

  it('grok-bots may post its own event types as a grok-<slug> only', async () => {
    expect((await call('POST', '/spine/events', BOTS, ev('grok_daily', 'grok-gina'))).status).toBe(200);
    const design = await call('POST', '/spine/events', BOTS, ev('design_request', 'grok-gina'));
    expect(design).toEqual({ status: 403, body: { error: 'policy: grok-bots may not post design_request' } });
    const asInbox = await call('POST', '/spine/events', BOTS, ev('grok_daily', 'grok-inbox'));
    expect(asInbox).toEqual({ status: 403, body: { error: 'policy: grok-bots may not post as grok-inbox' } });
    expect((await call('POST', '/spine/events', BOTS, ev('grok_daily', 'marketing-manager'))).status).toBe(403);
    expect(eventCount()).toBe(1);
  });

  it('grok-bots may drain grok_task_* only, and a refused type drains nothing', async () => {
    insertEvent(db, ev('grok_task_gina', 'grok-task'), NOW);
    insertEvent(db, ev('grok_task_bob', 'grok-task'), NOW);
    insertEvent(db, ev('grok_daily', 'grok-gina'), NOW);
    const ok = await call('GET', '/spine/events/drain?types=grok_task_gina', BOTS);
    expect(ok.status).toBe(200);
    expect(ok.body.events).toHaveLength(1);
    expect(await call('GET', '/spine/events/drain?types=grok_daily', BOTS))
      .toEqual({ status: 403, body: { error: 'policy: grok-bots may not drain grok_daily' } });
    expect((await call('GET', '/spine/events/drain?types=grok_task_bob,grok_daily', BOTS)).status).toBe(403);
    expect(undrained('grok_task_bob')).toBe(1);
    expect(undrained('grok_daily')).toBe(1);
  });

  it('grok-bots may not read pending, post outcomes, read hands or read brands', async () => {
    expect(await call('GET', '/spine/events/pending?types=design_request', BOTS))
      .toEqual({ status: 403, body: { error: 'policy: grok-bots may not read pending design_request' } });
    expect(await call('POST', '/spine/outcomes', BOTS, {}))
      .toEqual({ status: 403, body: { error: 'policy: grok-bots may not post outcomes' } });
    expect(await call('GET', '/spine/hands/content-engine/x?brand=dearborn-denim', BOTS))
      .toEqual({ status: 403, body: { error: 'policy: grok-bots may not read hands' } });
    expect(handFetch).not.toHaveBeenCalled();
    for (const url of ['/spine/brands', '/spine/brands/dearborn-denim']) {
      expect(await call('GET', url, BOTS)).toEqual({ status: 403, body: { error: 'policy: grok-bots may not read brands' } });
    }
  });

  it('caps grok-bots at events_per_hour across every grok- source, ignoring older events', async () => {
    insertEvent(db, ev('grok_daily', 'grok-old'), '2026-09-07T10:00:00.000Z');
    for (const bot of ['grok-a', 'grok-b', 'grok-c']) {
      expect((await call('POST', '/spine/events', BOTS, ev('grok_daily', bot))).status, bot).toBe(200);
    }
    expect(await call('POST', '/spine/events', BOTS, ev('grok_daily', 'grok-d')))
      .toEqual({ status: 429, body: { error: 'policy: grok-bots is over 3 events per hour' } });
    expect(eventCount()).toBe(4);
  });

  it('caps grok-bots at proposals_per_hour, ignoring older proposals', async () => {
    insertProposal(db, { ...note('grok_lead', 'notes', 'old'), agent: 'grok-bots' } as ProposalInput, '2026-09-07T10:00:00.000Z');
    for (const title of ['a', 'b']) {
      expect((await call('POST', '/spine/proposals', BOTS, note('grok_lead', 'notes', title))).status, title).toBe(200);
    }
    expect(await call('POST', '/spine/proposals', BOTS, note('grok_lead', 'notes', 'c')))
      .toEqual({ status: 429, body: { error: 'policy: grok-bots is over 2 proposals per hour' } });
    expect(filed).toHaveLength(2);
  });

  it('grok-bots may not post runs', async () => {
    expect(await call('POST', '/spine/runs', BOTS, {}))
      .toEqual({ status: 403, body: { error: 'policy: grok-bots may not post runs' } });
  });

  it('grok-inbox may drain bot reports and file notes cards but may not post events', async () => {
    insertEvent(db, ev('grok_daily', 'grok-gina'), NOW);
    const drained = await call('GET', '/spine/events/drain?types=grok_daily', INBOX);
    expect(drained.status).toBe(200);
    expect(drained.body.events).toHaveLength(1);
    expect((await call('POST', '/spine/events', INBOX, ev('grok_daily', 'grok-inbox'))).status).toBe(403);
    expect((await call('POST', '/spine/proposals', INBOX, note('grok_lead'))).status).toBe(200);
    expect(filed).toEqual([expect.objectContaining({ agent: 'grok-inbox' })]);
  });

  it('grok-task may post grok_task_* as itself only, and may not drain or propose', async () => {
    expect((await call('POST', '/spine/events', TASK, ev('grok_task_gina', 'grok-task'))).status).toBe(200);
    expect((await call('POST', '/spine/events', TASK, ev('grok_task_gina', 'grok-gina'))).status).toBe(403);
    expect((await call('GET', '/spine/events/drain?types=grok_task_gina', TASK)).status).toBe(403);
    expect(undrained('grok_task_gina')).toBe(1);
    expect(await call('POST', '/spine/proposals', TASK, note('grok_lead')))
      .toEqual({ status: 403, body: { error: 'policy: grok-task may not file proposals' } });
    expect(filed).toHaveLength(0);
  });

  it('GET /spine/policy/self returns the caller\'s own entry', async () => {
    expect(await call('GET', '/spine/policy/self', BOTS))
      .toEqual({ status: 200, body: { agent: 'grok-bots', restricted: true, policy: policy.get('grok-bots') } });
    expect(await call('GET', '/spine/policy/self', KEY))
      .toEqual({ status: 200, body: { agent: 'marketing-manager', restricted: false, policy: null } });
    expect((await call('GET', '/spine/policy/self')).status).toBe(401);
  });
});
