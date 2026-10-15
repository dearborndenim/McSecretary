/**
 * Build C5 — the sample gate on the spine (spec 2026-10-15 §3.6, §4.7).
 *
 * The Pattern Maker files `sample_approval` after a `pattern_draft` executes
 * (pinned → always a card); Robert's decision is the verdict: Approve executes
 * `POST design-module /api/techpacks/<tid>/proven {verdict: approved}`, Reject
 * executes the same with `verdict: rejected`; both emit
 * `sample_approval_executed` with `techpack_id`, `verdict`, `brand` flat.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import { insertProposal, getProposalById, setTelegramRef } from '../../src/db/proposal-queries.js';
import { fileProposal, type RouterDeps } from '../../src/spine/router.js';
import { executeProposal, type ExecutorDeps } from '../../src/spine/executor.js';
import { renderProposalCard, handleProposalCallback, handleEditReply, type CardDeps } from '../../src/spine/telegram-card.js';
import { isPinned } from '../../src/spine/gates.js';
import { validateSamplePayload } from '../../src/spine/sample-approval.js';
import type { ActionPayload, ProposalInput } from '../../src/spine/types.js';
import type { BrandConfig } from '../../src/spine/brand-config.js';

const NOW = '2026-10-15T12:00:00.000Z';
const brand: BrandConfig = {
  brand_id: 'dearborn-denim', display_name: 'DD', inbox_user_id: 'robert-mcmillan',
  shopify_store: 's', meta_ad_account: 'm', silent_budget_usd: 500, exploration_share: 0.2,
  proposal_expiry_hours: 48,
  hands: { 'design-module': { url_env: 'DESIGN_MODULE_URL', key_env: 'DESIGN_MODULE_KEY', forward_brand: 'brand' } },
};

/** What the Pattern Maker files (agents/pattern-maker/SKILL.md, R6). */
function sampleInput(over: Partial<ProposalInput> = {}): ProposalInput {
  return {
    agent: 'pattern-maker', brand_id: 'dearborn-denim', action_type: 'sample_approval',
    action_payload: {
      hand: 'design-module', method: 'POST', path: '/api/techpacks/ballow-proving-sweatshirt/proven',
      body: {
        techpack_id: 'ballow-proving-sweatshirt', revision: 1, pieces: 7,
        critic: { score: 96, defects: 0, warnings: 1 },
        verdict: 'approved', notes: '', fail_notes: '', sample_ref: '',
      },
    },
    reason: 'Ballow Proving Sweatshirt r1 is drafted (archetype knit_setin_sweat, 7 pieces, critic 96/100 with 0 defect(s)). Sew the sample.',
    evidence: {
      techpack_id: 'ballow-proving-sweatshirt', revision: 1, garment: 'Ballow Proving Sweatshirt',
      archetype: 'knit_setin_sweat', pieces: 7, drafted_callouts: '["drape.cowl"]',
    },
    cost_usd: 0, reversible: true, level_required: 1, expires_at: '2026-10-29T12:00:00.000Z',
    ...over,
  };
}

const proven = {
  ok: true, id: 'ballow-proving-sweatshirt', revision: 1, brand: 'dearborn-denim',
  archetype: 'knit_setin_sweat', verdict: 'approved', proven: ['drape.cowl'], flipped: ['drape.cowl'],
  overlay_path: '/data/config/dearborn-denim/design-language-maturity.json',
  sample: { verdict: 'approved', notes: '', sample_ref: null, at: NOW },
};

function execDeps(fetchImpl: ExecutorDeps['fetch']): ExecutorDeps {
  return {
    fetch: fetchImpl,
    env: { DESIGN_MODULE_URL: 'https://dm.example/', DESIGN_MODULE_KEY: 'secret' },
    loadBrand: () => brand, now: () => NOW,
  };
}

function events(db: Database.Database) {
  return db.prepare('SELECT * FROM spine_events ORDER BY id').all() as Array<{ event_type: string; payload: string; urgent: number }>;
}

describe('sample_approval: pinned routing', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); initializeSchema(db); });
  afterEach(() => db.close());

  it('is pinned, so the Pattern Maker filing is always a card, even if the ledger said 3', async () => {
    expect(isPinned('sample_approval')).toBe(true);
    db.prepare("INSERT INTO trust_ledger (agent, brand_id, action_type, level) VALUES ('pattern-maker', 'dearborn-denim', 'sample_approval', 3)").run();
    const cards: number[] = []; const executed: number[] = [];
    const d: RouterDeps = {
      now: () => NOW,
      sendCard: async (id) => { cards.push(id); return { chatId: '555', messageId: 42 }; },
      execute: async (id) => { executed.push(id); return { ok: true, http_status: 200, body: {} }; },
      report: async () => {}, silentBudgetUsd: () => 500,
    };
    const r = await fileProposal(db, sampleInput(), d);
    expect(r.routed).toBe('card');
    expect(cards).toHaveLength(1);
    expect(executed).toHaveLength(0);
    expect(getProposalById(db, cards[0]!)!.status).toBe('pending');
  });

  it('the card is the sample request: pack, pieces, critic, what a pass proves, what each button does', () => {
    const id = insertProposal(db, sampleInput(), NOW).id;
    const text = renderProposalCard(getProposalById(db, id)!);
    expect(text).toContain('Sew a sample: Ballow Proving Sweatshirt r1 · 7 pieces · knit_setin_sweat');
    expect(text).toContain('Critic 96/100 — 0 defect(s)');
    expect(text).toContain('A pass proves: ["drape.cowl"]');
    expect(text).toContain('Approve = sample passed · Reject = sample failed');
    expect(text).not.toContain('/proven');
  });
});

describe('executeProposal: sample_approval (design-module /proven)', () => {
  let db: Database.Database;
  let id: number;
  beforeEach(() => {
    db = new Database(':memory:'); initializeSchema(db);
    id = insertProposal(db, sampleInput(), NOW).id;
  });
  afterEach(() => db.close());

  it('POSTs the verdict to the pack\'s /proven route and emits sample_approval_executed with techpack_id, verdict, brand flat', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(proven), { status: 200 }));
    const r = await executeProposal(db, id, execDeps(fetchMock));
    expect(r.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('https://dm.example/api/techpacks/ballow-proving-sweatshirt/proven?brand=dearborn-denim');
    expect(init.method).toBe('POST');
    const sent = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(sent.verdict).toBe('approved');
    expect(sent.techpack_id).toBe('ballow-proving-sweatshirt');
    expect(getProposalById(db, id)!.status).toBe('executed');
    const ev = events(db);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.event_type).toBe('sample_approval_executed');
    expect(ev[0]!.urgent).toBe(1);
    const payload = JSON.parse(ev[0]!.payload) as Record<string, unknown>;
    expect(payload.techpack_id).toBe('ballow-proving-sweatshirt');
    expect(payload.verdict).toBe('approved');
    expect(payload.brand).toBe('dearborn-denim');
    expect(payload.revision).toBe(1);
    expect((payload.response as Record<string, unknown>).proven).toEqual(['drape.cowl']);
  });

  it('the brand on the event is the PACK\'s brand design-module answered, not the spine brand', async () => {
    const r = await executeProposal(db, id, execDeps(async () =>
      new Response(JSON.stringify({ ...proven, brand: 'ballow' }), { status: 200 })));
    expect(r.ok).toBe(true);
    expect(JSON.parse(events(db)[0]!.payload).brand).toBe('ballow');
  });

  it('a bare {ok:true} still yields techpack_id, verdict and the spine brand', async () => {
    await executeProposal(db, id, execDeps(async () => new Response('{"ok":true}', { status: 200 })));
    const payload = JSON.parse(events(db)[0]!.payload) as Record<string, unknown>;
    expect(payload).toMatchObject({ techpack_id: 'ballow-proving-sweatshirt', verdict: 'approved', brand: 'dearborn-denim' });
  });

  it('a 409 not_drafted fails the row and emits nothing', async () => {
    const r = await executeProposal(db, id, execDeps(async () =>
      new Response(JSON.stringify({ ok: false, error: 'not_drafted' }), { status: 409 })));
    expect(r.ok).toBe(false);
    expect(getProposalById(db, id)!.status).toBe('failed');
    expect(events(db)).toHaveLength(0);
  });

  it('refuses a sample card pointed anywhere but the pack\'s /proven route, without calling the hand', async () => {
    for (const payload of [
      { hand: 'design-module', method: 'POST', path: '/api/techpacks/ballow-proving-sweatshirt/draft', body: { techpack_id: 'ballow-proving-sweatshirt', verdict: 'approved' } },
      { hand: 'design-module', method: 'POST', path: '/api/techpacks/other/proven', body: { techpack_id: 'ballow-proving-sweatshirt', verdict: 'approved' } },
      { hand: 'design-module', method: 'POST', path: '/api/techpacks/ballow-proving-sweatshirt/proven', body: { techpack_id: 'ballow-proving-sweatshirt', verdict: 'maybe' } },
      { hand: 'ad-manager', method: 'POST', path: '/api/techpacks/ballow-proving-sweatshirt/proven', body: { techpack_id: 'ballow-proving-sweatshirt', verdict: 'approved' } },
    ] as ActionPayload[]) {
      expect(validateSamplePayload(payload).ok).toBe(false);
      const bad = insertProposal(db, sampleInput({ action_payload: payload }), NOW).id;
      const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
      const r = await executeProposal(db, bad, execDeps(fetchMock));
      expect(r.ok).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(getProposalById(db, bad)!.status).toBe('failed');
    }
    expect(events(db)).toHaveLength(0);
  });
});

describe('the card decision is the verdict', () => {
  let db: Database.Database;
  let id: number;
  let sent: Array<Record<string, unknown>>;
  let cardDeps: CardDeps & { replies: string[] };
  beforeEach(() => {
    db = new Database(':memory:'); initializeSchema(db);
    id = insertProposal(db, sampleInput(), NOW).id;
    setTelegramRef(db, id, '555', 1);
    sent = [];
    const replies: string[] = [];
    const fetchImpl = async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      sent.push(body);
      return new Response(JSON.stringify({ ...proven, verdict: body.verdict, proven: body.verdict === 'approved' ? ['drape.cowl'] : [] }), { status: 200 });
    };
    cardDeps = {
      now: () => NOW, replies,
      reply: async (t) => { replies.push(t); },
      execute: (pid) => executeProposal(db, pid, execDeps(fetchImpl)),
    };
  });
  afterEach(() => db.close());

  it('Approve passes the sample', async () => {
    const r = await handleProposalCallback(db, { action: 'approve', id }, '555', 'robert', cardDeps);
    expect(r.ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.verdict).toBe('approved');
    expect(JSON.parse(events(db)[0]!.payload).verdict).toBe('approved');
  });

  it('Reject fails the sample: it still executes, with verdict rejected, and the event says so', async () => {
    const r = await handleProposalCallback(db, { action: 'reject', id }, '555', 'robert', cardDeps);
    expect(r).toEqual({ ok: true, message: 'sample_rejected' });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.verdict).toBe('rejected');
    const row = getProposalById(db, id)!;
    expect(row.status).toBe('executed');
    expect(row.decided_by).toBe('robert');
    expect(JSON.parse(row.action_payload).body.verdict).toBe('rejected');
    const ev = events(db);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.event_type).toBe('sample_approval_executed');
    expect(JSON.parse(ev[0]!.payload)).toMatchObject({ verdict: 'rejected', techpack_id: 'ballow-proving-sweatshirt' });
    expect(cardDeps.replies[0]).toContain('Sample rejected #');
    // a second tap is refused
    const again = await handleProposalCallback(db, { action: 'reject', id }, '555', 'robert', cardDeps);
    expect(again.ok).toBe(false);
    expect(sent).toHaveLength(1);
  });

  it('Edit fail_notes=<text> fails the sample with those notes; fail_notes never reaches design-module', async () => {
    await handleProposalCallback(db, { action: 'edit', id }, '555', 'robert', cardDeps);
    const handled = await handleEditReply(db, '555', 'fail_notes=cowl collapses at CF', 'robert', cardDeps);
    expect(handled).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ verdict: 'rejected', notes: 'cowl collapses at CF' });
    expect(sent[0]).not.toHaveProperty('fail_notes');
    expect(getProposalById(db, id)!.status).toBe('executed');
    expect(JSON.parse(events(db)[0]!.payload).verdict).toBe('rejected');
  });

  it('Edit notes=<text> passes the sample with notes', async () => {
    await handleProposalCallback(db, { action: 'edit', id }, '555', 'robert', cardDeps);
    await handleEditReply(db, '555', 'notes=hand feel is right, cowl sits well', 'robert', cardDeps);
    expect(sent[0]).toMatchObject({ verdict: 'approved', notes: 'hand feel is right, cowl sits well' });
  });
});
