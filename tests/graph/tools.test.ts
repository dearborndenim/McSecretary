import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import { initializeSchema } from '../../src/db/schema.js';
import { insertProposal } from '../../src/db/proposal-queries.js';
import { insertEvent, drainEvents } from '../../src/db/event-queries.js';
import { upsertRun } from '../../src/db/run-index-queries.js';
import { GRAPH_TOOL_DEFINITIONS, isGraphTool, executeGraphTool, setGraphDeps } from '../../src/graph/tools.js';
import type { ProposalInput } from '../../src/spine/types.js';

const NOW = '2026-09-11T12:00:00.000Z';
const BRANDS = path.join(process.cwd(), 'config', 'brands');
const AGENTS = new Map([['k1', 'finance'], ['k2', 'sourcing'], ['k3', 'designer']]);
const ENV = {
  DESIGN_MODULE_URL: 'https://dm.test', DESIGN_MODULE_KEY: 'k',
  PRODUCT_DEV_URL: 'https://pd.test', PRODUCT_DEV_KEY: 'k',
  QUICKBOOKS_SYNC_URL: 'https://qb.test', QUICKBOOKS_SYNC_KEY: 'k',
};

let db: Database.Database;
let filed: ProposalInput[];
let fetched: string[];

function wire(over: Partial<Parameters<typeof setGraphDeps>[0] & object> = {}) {
  filed = []; fetched = [];
  setGraphDeps({
    db, brandId: 'dearborn-denim', brandsDir: BRANDS, agentKeys: AGENTS,
    env: ENV,
    now: () => NOW,
    file: async (input) => { filed.push(input); const { id } = insertProposal(db, input, NOW); return { id, routed: 'card' as const }; },
    handFetch: async (url) => { fetched.push(url); return new Response(JSON.stringify({ personas: [
      { slug: 'a', line: 'mens', status: 'approved' }, { slug: 'b', line: 'mens', status: 'approved' }, { slug: 'c', line: 'mens', status: 'draft' },
      { slug: 'd', line: 'womens', status: 'approved' }, { slug: 'e', line: 'womens', status: 'approved' },
    ] }), { status: 200, headers: { 'content-type': 'application/json' } }); },
    ...over,
  });
}

beforeEach(() => { db = new Database(':memory:'); initializeSchema(db); wire(); });
afterEach(() => { db.close(); setGraphDeps(null); });

describe('tool definitions', () => {
  it('defines exactly the four graph tools with their required inputs', () => {
    expect(GRAPH_TOOL_DEFINITIONS.map((t) => t.name)).toEqual(
      ['propose_graph_dispatch', 'read_agent_outputs', 'read_hand', 'request_agent_run']);
    const byName = new Map(GRAPH_TOOL_DEFINITIONS.map((t) => [t.name, t.input_schema as { required?: string[] }]));
    expect(byName.get('propose_graph_dispatch')!.required).toEqual(['plan']);
    expect(byName.get('read_agent_outputs')!.required).toEqual(['agent']);
    expect(byName.get('read_hand')!.required).toEqual(['hand', 'path']);
    expect(byName.get('request_agent_run')!.required).toEqual(['agent', 'reason']);
  });

  it('isGraphTool recognises its own names and nothing else', () => {
    expect(isGraphTool('read_hand')).toBe(true);
    expect(isGraphTool('send_email')).toBe(false);
  });
});

describe('propose_graph_dispatch', () => {
  const ROBERT_PLAN = {
    summary: 'Four knit concepts across both lines, fabrics from American Fabrics International, PFD.',
    briefs: ['waffle knit', 'rugby jersey', 'thermal knit', 'pigment-dyed jersey'].map((f) => ({
      collection_name: `${f.replace(/\b\w/g, (c) => c.toUpperCase())} Capsule`,
      line: 'both',
      brief_text: `A capsule built on ${f}. Fabric comes from American Fabrics International; we buy PFD and dye in-house in Chicago.`,
      fabric_locks: [f], vendor: 'american-fabrics-international', dye_program: 'pfd_house_dye',
    })),
    vendor_contacts: [{ vendor_name: 'American Fabrics International', slug: 'american-fabrics-international', contact_name: 'Ned Pilchman', email: 'marteva@hotmail.com' }],
  };

  it("files Robert's example as one pinned level-1 card: 8 briefs, 1 contact, PFD", async () => {
    const out = await executeGraphTool('propose_graph_dispatch', { plan: ROBERT_PLAN });
    expect(filed).toHaveLength(1);
    const f = filed[0]!;
    expect(f.agent).toBe('mcsecretary');
    expect(f.action_type).toBe('graph_dispatch');
    expect(f.level_required).toBe(1);
    expect(f.cost_usd).toBe(0);
    expect(f.reversible).toBe(false);
    expect(f.expires_at).toBe('2026-09-13T12:00:00.000Z');   // 48h, from the brand config
    expect(f.action_payload).toMatchObject({ hand: 'graph', method: 'POST', path: '/dispatch' });
    const plan = f.action_payload.body as unknown as { briefs: unknown[]; vendor_contacts: { email: string }[] };
    expect(plan.briefs).toHaveLength(8);
    expect(plan.briefs.filter((b) => (b as { line: string }).line === 'mens')).toHaveLength(4);
    expect((plan.briefs[0] as { dye_program: string }).dye_program).toBe('pfd_house_dye');
    expect(plan.vendor_contacts[0]!.email).toBe('marteva@hotmail.com');
    expect(f.evidence).toEqual({ briefs: 8, design_runs_estimated: 16, vendor_contacts: 1, run_requests: 0 });
    expect(f.reason).toContain('American Fabrics International');
    expect(out).toMatch(/#\d+/);
    expect(out).toContain('Approve');
  });

  it('reads approved personas once and estimates 4 mens briefs × 2 + 4 womens briefs × 2', async () => {
    await executeGraphTool('propose_graph_dispatch', { plan: ROBERT_PLAN });
    expect(fetched).toHaveLength(1);
    expect(fetched[0]).toBe('https://dm.test/api/config/personas');
    expect(filed[0]!.evidence.design_runs_estimated).toBe(16);
  });

  it('still files, with "per approved persona" in the reason, when the personas read fails', async () => {
    wire({ handFetch: async () => new Response('nope', { status: 500 }) });
    await executeGraphTool('propose_graph_dispatch', { plan: ROBERT_PLAN });
    expect(filed).toHaveLength(1);
    expect(filed[0]!.reason).toContain('per approved persona');
    expect(filed[0]!.evidence.design_runs_estimated).toBeNull();
  });

  it('still files when the personas hand throws outright', async () => {
    wire({ handFetch: async () => { throw new Error('ECONNREFUSED'); } });
    await executeGraphTool('propose_graph_dispatch', { plan: ROBERT_PLAN });
    expect(filed).toHaveLength(1);
    expect(filed[0]!.evidence.design_runs_estimated).toBeNull();
  });

  it('reports the same card number instead of filing twice for a repeated message', async () => {
    const first = await executeGraphTool('propose_graph_dispatch', { plan: ROBERT_PLAN });
    const second = await executeGraphTool('propose_graph_dispatch', { plan: ROBERT_PLAN });
    expect(second).toBe(first);
    expect(db.prepare('SELECT COUNT(*) AS n FROM proposals').get()).toEqual({ n: 1 });
  });

  it('returns the validation error and files nothing for an invalid plan', async () => {
    const out = await executeGraphTool('propose_graph_dispatch', { plan: { summary: 's', briefs: [] } });
    expect(filed).toEqual([]);
    expect(out).toContain('at least one');
  });

  it('rejects a run_request naming an unknown agent and files nothing', async () => {
    const out = await executeGraphTool('propose_graph_dispatch', { plan: { summary: 's', run_requests: [{ agent: 'nope', reason: 'x' }] } });
    expect(filed).toEqual([]);
    expect(out).toContain('finance');
  });
});

describe('read_agent_outputs', () => {
  it('returns the newest proposals with status, reason, evidence and the notes body', async () => {
    insertProposal(db, {
      agent: 'finance', brand_id: 'dearborn-denim', action_type: 'cash_floor_alert',
      action_payload: { hand: 'notes', method: 'POST', path: '/note', body: { title: 'Cash under floor', summary: 'Cash $41k vs floor $60k.' } },
      reason: 'cash is under the floor', evidence: { cash_usd: 41000 }, cost_usd: 0, reversible: true,
      level_required: 1, expires_at: '2026-09-13T00:00:00.000Z',
    }, '2026-09-10T06:00:00.000Z');
    upsertRun(db, { run_id: 'r1', agent: 'finance', brand_id: 'dearborn-denim', skill_commit: 'c', model: 'm', started_at: '2026-09-11T06:00:00.000Z', finished_at: null, outcome: 'ok', notes: '' });
    const out = await executeGraphTool('read_agent_outputs', { agent: 'finance' });
    const j = JSON.parse(out);
    expect(j.latest_run_at).toBe('2026-09-11T06:00:00.000Z');
    expect(j.stale).toBe(false);
    expect(j.proposals[0]).toMatchObject({
      action_type: 'cash_floor_alert', status: 'pending',
      reason: 'cash is under the floor', evidence: { cash_usd: 41000 },
      body: { title: 'Cash under floor', summary: 'Cash $41k vs floor $60k.' },
    });
  });

  it('omits the body for a hand-call proposal, whose body is a request not a report', async () => {
    insertProposal(db, {
      agent: 'sourcing', brand_id: 'dearborn-denim', action_type: 'rfq_send',
      action_payload: { hand: 'product-dev', method: 'POST', path: '/api/integration/x', body: { secret: 'request shape' } },
      reason: 'sending an RFQ', evidence: {}, cost_usd: 0, reversible: true,
      level_required: 1, expires_at: '2026-09-13T00:00:00.000Z',
    }, NOW);
    const j = JSON.parse(await executeGraphTool('read_agent_outputs', { agent: 'sourcing' }));
    expect(j.proposals[0].body).toBeUndefined();
    expect(j.proposals[0].reason).toBe('sending an RFQ');
  });

  it('is stale at exactly 24h + 1ms and fresh at exactly 24h', async () => {
    upsertRun(db, { run_id: 'r1', agent: 'finance', brand_id: 'dearborn-denim', skill_commit: 'c', model: 'm', started_at: '2026-09-10T12:00:00.000Z', finished_at: null, outcome: 'ok', notes: '' });
    expect(JSON.parse(await executeGraphTool('read_agent_outputs', { agent: 'finance' })).stale).toBe(false);
    upsertRun(db, { run_id: 'r2', agent: 'sourcing', brand_id: 'dearborn-denim', skill_commit: 'c', model: 'm', started_at: '2026-09-10T11:59:59.999Z', finished_at: null, outcome: 'ok', notes: '' });
    expect(JSON.parse(await executeGraphTool('read_agent_outputs', { agent: 'sourcing' })).stale).toBe(true);
  });

  it('is stale when the agent has never run', async () => {
    const j = JSON.parse(await executeGraphTool('read_agent_outputs', { agent: 'designer' }));
    expect(j.latest_run_at).toBeNull();
    expect(j.stale).toBe(true);
  });

  it('clamps limit to 20 and defaults to 5', async () => {
    for (let i = 0; i < 25; i++) {
      insertProposal(db, { agent: 'finance', brand_id: 'dearborn-denim', action_type: 'x', action_payload: { hand: 'notes', method: 'POST', path: '/note', body: { title: `t${i}`, summary: 's' } }, reason: `r${i}`, evidence: {}, cost_usd: 0, reversible: true, level_required: 1, expires_at: '2026-09-13T00:00:00.000Z' }, `2026-09-10T06:00:${String(i).padStart(2, '0')}.000Z`);
    }
    expect(JSON.parse(await executeGraphTool('read_agent_outputs', { agent: 'finance' })).proposals).toHaveLength(5);
    expect(JSON.parse(await executeGraphTool('read_agent_outputs', { agent: 'finance', limit: 99 })).proposals).toHaveLength(20);
    expect(JSON.parse(await executeGraphTool('read_agent_outputs', { agent: 'finance', limit: 0 })).proposals).toHaveLength(1);
  });

  it('lists the known agents for an unknown name', async () => {
    const out = await executeGraphTool('read_agent_outputs', { agent: 'marketing' });
    expect(out).toContain('finance');
    expect(out).toContain('sourcing');
    expect(out).not.toContain('mcsecretary');
  });
});

describe('read_hand', () => {
  it('proxies a GET to the configured hand and returns the body', async () => {
    wire({ handFetch: async (url) => { fetched.push(url); return new Response(JSON.stringify({ cash_usd: 41000 }), { status: 200 }); } });
    const out = await executeGraphTool('read_hand', { hand: 'quickbooks-sync', path: '/api/integration/finance-week' });
    expect(out).toContain('41000');
    expect(fetched).toEqual(['https://qb.test/api/integration/finance-week']);
  });

  it('rejects a path outside /api/integration/', async () => {
    const out = await executeGraphTool('read_hand', { hand: 'design-module', path: '/api/config/personas' });
    expect(out).toContain('/api/integration/');
    expect(fetched).toEqual([]);
  });

  it('rejects a path that escapes the hand origin', async () => {
    const out = await executeGraphTool('read_hand', { hand: 'design-module', path: '/api/integration/../../etc' });
    expect(out.toLowerCase()).toContain('path');
    expect(fetched).toEqual([]);
  });

  it('rejects a hand not in the brand config', async () => {
    const out = await executeGraphTool('read_hand', { hand: 'shopify', path: '/api/integration/x' });
    expect(out).toContain('Unknown hand');
    expect(fetched).toEqual([]);
  });

  it('refuses the built-in hands, which have no upstream to read', async () => {
    for (const hand of ['notes', 'email', 'graph']) {
      expect(await executeGraphTool('read_hand', { hand, path: '/api/integration/x' })).toContain('Unknown hand');
    }
    expect(fetched).toEqual([]);
  });

  it('reports a non-2xx hand response instead of returning its body', async () => {
    wire({ handFetch: async () => new Response('boom', { status: 503 }) });
    const out = await executeGraphTool('read_hand', { hand: 'design-module', path: '/api/integration/x' });
    expect(out).toContain('503');
    expect(out).not.toContain('boom');
  });

  it('truncates a body over 8 KB', async () => {
    wire({ handFetch: async () => new Response('y'.repeat(20000), { status: 200 }) });
    const out = await executeGraphTool('read_hand', { hand: 'design-module', path: '/api/integration/x' });
    expect(out.length).toBeLessThan(8300);
    expect(out).toContain('[truncated]');
  });

  it('answers with a sentence instead of throwing when the hand env is missing', async () => {
    const out = await executeGraphTool('read_hand', { hand: 'ad-manager', path: '/api/integration/shopify-week' });
    expect(out).toContain('AD_MANAGER_URL');
    expect(fetched).toEqual([]);
  });
});

describe('request_agent_run', () => {
  it('inserts one urgent run_request_<agent> event from mcsecretary', async () => {
    const out = await executeGraphTool('request_agent_run', { agent: 'finance', reason: 'Robert asked about cashflow' });
    const events = drainEvents(db, 'x', ['run_request_finance'], NOW);
    expect(events).toHaveLength(1);
    expect(events[0]!.source_hand).toBe('mcsecretary');
    expect(events[0]!.urgent).toBe(1);
    expect(JSON.parse(events[0]!.payload)).toEqual({ agent: 'finance', reason: 'Robert asked about cashflow', requested_via: 'telegram' });
    expect(out).toContain('finance');
  });

  it('skips when an undrained run request for that agent already exists', async () => {
    insertEvent(db, { source_hand: 'mcsecretary', brand_id: 'dearborn-denim', event_type: 'run_request_finance', payload: {}, urgent: true }, NOW);
    const out = await executeGraphTool('request_agent_run', { agent: 'finance', reason: 'again' });
    expect(out).toContain('already');
    expect(drainEvents(db, 'x', ['run_request_finance'], NOW)).toHaveLength(1);
  });

  it('files a second request once the first was drained', async () => {
    insertEvent(db, { source_hand: 'mcsecretary', brand_id: 'dearborn-denim', event_type: 'run_request_finance', payload: {}, urgent: true }, NOW);
    drainEvents(db, 'finance', ['run_request_finance'], NOW);
    await executeGraphTool('request_agent_run', { agent: 'finance', reason: 'again' });
    expect(drainEvents(db, 'x', ['run_request_finance'], NOW)).toHaveLength(1);
  });

  it('rejects an unknown agent', async () => {
    const out = await executeGraphTool('request_agent_run', { agent: 'nope', reason: 'x' });
    expect(out).toContain('finance');
    expect(drainEvents(db, 'x', ['run_request_nope'], NOW)).toHaveLength(0);
  });

  it('rejects a blank reason', async () => {
    const out = await executeGraphTool('request_agent_run', { agent: 'finance', reason: '   ' });
    expect(out).toContain('reason');
    expect(drainEvents(db, 'x', ['run_request_finance'], NOW)).toHaveLength(0);
  });
});

describe('no deps wired', () => {
  it('every tool answers with one plain sentence rather than throwing', async () => {
    setGraphDeps(null);
    for (const t of GRAPH_TOOL_DEFINITIONS) {
      const out = await executeGraphTool(t.name, {});
      expect(out).toContain('not configured');
    }
  });
});
