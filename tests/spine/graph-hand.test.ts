import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import { initializeSchema } from '../../src/db/schema.js';
import { insertProposal, getProposalById } from '../../src/db/proposal-queries.js';
import { drainEvents } from '../../src/db/event-queries.js';
import { executeProposal } from '../../src/spine/executor.js';
import { loadBrandConfig } from '../../src/spine/brand-config.js';
import { validateGraphPayload } from '../../src/spine/graph-hand.js';
import type { ProposalInput, ActionPayload } from '../../src/spine/types.js';

const NOW = '2026-09-11T12:00:00.000Z';
const BRANDS = path.join(process.cwd(), 'config', 'brands');
const loadBrand = (id: string) => loadBrandConfig(BRANDS, id);
const deps = () => ({
  fetch: async () => { throw new Error('the graph hand must never make an HTTP call'); },
  env: {}, loadBrand, now: () => NOW,
});

const PLAN = {
  summary: 'Two knit concepts, both lines.',
  briefs: [
    { collection_name: 'Waffle Knit', line: 'mens', brief_text: 'x'.repeat(60), season: 'Winter 2026', target_launch: '2026-11-06', product_count: 4, price_ladder: ['core'], fabric_locks: ['waffle knit'], vendor: 'american-fabrics-international', dye_program: 'pfd_house_dye', persona: 'all' },
    { collection_name: 'Waffle Knit', line: 'womens', brief_text: 'x'.repeat(60), season: 'Winter 2026', target_launch: '2026-11-06', product_count: 4, price_ladder: ['core'], fabric_locks: ['waffle knit'], vendor: 'american-fabrics-international', dye_program: 'pfd_house_dye', persona: 'all' },
  ],
  vendor_contacts: [{ vendor_name: 'American Fabrics International', slug: 'american-fabrics-international', contact_name: 'Ned Pilchman', email: 'marteva@hotmail.com', phone: null, sells: null, notes: null }],
  run_requests: [{ agent: 'sourcing', reason: 'pick up the new intents' }],
};

function input(body: unknown = PLAN): ProposalInput {
  return {
    agent: 'mcsecretary', brand_id: 'dearborn-denim', action_type: 'graph_dispatch',
    action_payload: { hand: 'graph', method: 'POST', path: '/dispatch', body: body as Record<string, unknown> },
    reason: 'r', evidence: {}, cost_usd: 0, reversible: false, level_required: 1,
    expires_at: '2026-09-13T12:00:00.000Z',
  };
}

describe('the built-in graph hand', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); initializeSchema(db); });
  afterEach(() => db.close());

  it('inserts one design_request per brief, one vendor_contact, one run_request_<agent>, and returns the counts', async () => {
    const { id } = insertProposal(db, input(), NOW);
    const r = await executeProposal(db, id, deps());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body).toMatchObject({ ok: true, design_requests: 2, vendor_contacts: 1, run_requests: 1 });
    expect((r.body as { event_ids: number[] }).event_ids).toHaveLength(4);

    const design = drainEvents(db, 'designer', ['design_request'], NOW);
    expect(design).toHaveLength(2);
    const p0 = JSON.parse(design[0]!.payload) as Record<string, unknown>;
    expect(p0).toMatchObject({
      collection_name: 'Waffle Knit', line: 'mens', persona: 'all',
      vendor: 'american-fabrics-international', dye_program: 'pfd_house_dye',
      brand: 'dearborn-denim', as_of: NOW, dispatch_proposal_id: id,
    });
    expect(design[0]!.source_hand).toBe('mcsecretary');
    expect(design[0]!.urgent).toBe(1);
    expect(JSON.parse(design[1]!.payload).line).toBe('womens');

    const contacts = drainEvents(db, 'sourcing', ['vendor_contact'], NOW);
    expect(contacts).toHaveLength(1);
    expect(JSON.parse(contacts[0]!.payload)).toMatchObject({ vendor_name: 'American Fabrics International', email: 'marteva@hotmail.com', dispatch_proposal_id: id });

    const runs = drainEvents(db, 'sourcing', ['run_request_sourcing'], NOW);
    expect(runs).toHaveLength(1);
    expect(JSON.parse(runs[0]!.payload)).toMatchObject({ agent: 'sourcing', reason: 'pick up the new intents', requested_via: 'telegram' });
  });

  it('marks the proposal executed and still fires graph_dispatch_executed', async () => {
    const { id } = insertProposal(db, input(), NOW);
    await executeProposal(db, id, deps());
    expect(getProposalById(db, id)!.status).toBe('executed');
    expect(drainEvents(db, 'x', ['graph_dispatch_executed'], NOW)).toHaveLength(1);
  });

  it('fails the proposal without inserting any event when the body re-validates badly', async () => {
    const { id } = insertProposal(db, input({ summary: 's', briefs: [], vendor_contacts: [], run_requests: [] }), NOW);
    const r = await executeProposal(db, id, deps());
    expect(r.ok).toBe(false);
    expect(getProposalById(db, id)!.status).toBe('failed');
    expect(drainEvents(db, 'x', ['design_request', 'vendor_contact', 'graph_dispatch_executed'], NOW)).toHaveLength(0);
  });

  it('fails an edited body whose brief is no longer valid, rather than dispatching it', async () => {
    const bad = { ...PLAN, briefs: [{ ...PLAN.briefs[0], brief_text: 'too short' }] };
    const { id } = insertProposal(db, input(bad), NOW);
    const r = await executeProposal(db, id, deps());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('brief_text');
    expect(drainEvents(db, 'x', ['design_request', 'vendor_contact'], NOW)).toHaveLength(0);
  });

  it('defaults a brief with no persona to "all" on the event', async () => {
    const body = { ...PLAN, briefs: [{ ...PLAN.briefs[0], persona: undefined }] };
    const { id } = insertProposal(db, input(body), NOW);
    await executeProposal(db, id, deps());
    const [e] = drainEvents(db, 'designer', ['design_request'], NOW);
    expect(JSON.parse(e!.payload).persona).toBe('all');
  });

  it('never calls a hand over HTTP', async () => {
    const { id } = insertProposal(db, input(), NOW);
    const r = await executeProposal(db, id, deps());
    expect(r.ok).toBe(true);
  });
});

describe('validateGraphPayload', () => {
  const p = (over: Partial<ActionPayload> = {}): ActionPayload =>
    ({ hand: 'graph', method: 'POST', path: '/dispatch', body: PLAN as unknown as Record<string, unknown>, ...over });

  it('accepts the canonical payload', () => {
    expect(validateGraphPayload(p()).ok).toBe(true);
  });
  it('rejects a method other than POST', () => {
    const r = validateGraphPayload(p({ method: 'PATCH' }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('POST');
  });
  it('rejects a path other than /dispatch', () => {
    expect(validateGraphPayload(p({ path: '/anything' })).ok).toBe(false);
  });
  it('rejects a body that is not a valid plan', () => {
    expect(validateGraphPayload(p({ body: { summary: '' } })).ok).toBe(false);
  });
  it('uses the clock it is given for the season and launch defaults', () => {
    const r = validateGraphPayload(p({ body: { summary: 's', briefs: [{ collection_name: 'C', brief_text: 'x'.repeat(60), line: 'mens' }] } }), NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.briefs[0]!.target_launch).toBe('2026-11-06');
  });
});
