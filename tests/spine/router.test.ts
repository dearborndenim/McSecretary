import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import { getProposalById } from '../../src/db/proposal-queries.js';
import { promoteTrust } from '../../src/db/trust-queries.js';
import { fileProposal, type RouterDeps } from '../../src/spine/router.js';
import type { ProposalInput } from '../../src/spine/types.js';

const NOW = '2026-09-07T12:00:00.000Z';
const K = { agent: 'marketing-manager', brand_id: 'dearborn-denim', action_type: 'creative_request' };

function input(over: Partial<ProposalInput> = {}): ProposalInput {
  return {
    ...K,
    action_payload: { hand: 'content-engine', method: 'POST', path: '/api/briefs', body: { angle: 'fit' } },
    reason: 'r', evidence: { a: 1 }, cost_usd: 0, reversible: true, level_required: 1,
    expires_at: '2026-09-09T00:00:00.000Z', ...over,
  };
}

function deps(): RouterDeps & { cards: number[]; executed: number[]; reports: string[] } {
  const cards: number[] = []; const executed: number[] = []; const reports: string[] = [];
  return {
    now: () => NOW,
    sendCard: async (id) => { cards.push(id); return { chatId: '555', messageId: 42 }; },
    execute: async (id) => { executed.push(id); return { ok: true, http_status: 200, body: {} }; },
    report: async (text) => { reports.push(text); },
    silentBudgetUsd: () => 500,
    cards, executed, reports,
  };
}

describe('fileProposal', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); initializeSchema(db); });
  afterEach(() => db.close());

  it('level 1 (default): sends a card, stores the telegram ref, does not execute', async () => {
    const d = deps();
    const r = await fileProposal(db, input(), d);
    expect(r.routed).toBe('card');
    expect(d.cards).toEqual([r.id]);
    expect(d.executed).toEqual([]);
    const row = getProposalById(db, r.id)!;
    expect(row.telegram_chat_id).toBe('555');
    expect(row.telegram_message_id).toBe(42);
  });

  it('level 2: executes immediately and reports', async () => {
    promoteTrust(db, K, 2, 'robert', NOW);
    const d = deps();
    const r = await fileProposal(db, input(), d);
    expect(r.routed).toBe('executed');
    expect(d.executed).toEqual([r.id]);
    expect(d.cards).toEqual([]);
    expect(d.reports[0]).toMatch(/Executed #\d+/);
  });

  it('level 3: executes silently when reversible and under budget', async () => {
    promoteTrust(db, K, 3, 'robert', NOW);
    const d = deps();
    const r = await fileProposal(db, input({ cost_usd: 100 }), d);
    expect(r.routed).toBe('executed_silent');
    expect(d.reports).toEqual([]);
  });

  it('level 3 falls back to level-2 behaviour when over budget or not reversible', async () => {
    promoteTrust(db, K, 3, 'robert', NOW);
    const d = deps();
    const a = await fileProposal(db, input({ cost_usd: 900 }), d);
    expect(a.routed).toBe('executed');
    const b = await fileProposal(db, input({ reversible: false, action_payload: { hand: 'content-engine', method: 'POST', path: '/api/briefs', body: { angle: 'x' } } }), d);
    expect(b.routed).toBe('executed');
    expect(d.reports).toHaveLength(2);
  });

  it('a pinned action always gets a card even if the ledger somehow says 3', async () => {
    db.prepare("INSERT INTO trust_ledger (agent, brand_id, action_type, level) VALUES (?, ?, 'ad_launch', 3)").run(K.agent, K.brand_id);
    const d = deps();
    const r = await fileProposal(db, input({ action_type: 'ad_launch' }), d);
    expect(r.routed).toBe('card');
  });

  it('level_required above the ledger level gets a card', async () => {
    promoteTrust(db, K, 2, 'robert', NOW);
    const d = deps();
    const r = await fileProposal(db, input({ level_required: 3 }), d);
    expect(r.routed).toBe('card');
  });

  it('a duplicate is neither re-sent nor re-executed', async () => {
    const d = deps();
    const a = await fileProposal(db, input(), d);
    const b = await fileProposal(db, input(), d);
    expect(b.id).toBe(a.id);
    expect(b.routed).toBe('deduped');
    expect(d.cards).toHaveLength(1);
  });

  it('card send failure leaves the proposal pending with no telegram ref', async () => {
    const d = deps();
    d.sendCard = async () => { throw new Error('telegram down'); };
    const r = await fileProposal(db, input(), d);
    expect(r.routed).toBe('card_failed');
    expect(getProposalById(db, r.id)!.status).toBe('pending');
  });

  it('a level-2 execution that the hand accepted but the row did not record is reported loudly', async () => {
    promoteTrust(db, K, 2, 'robert', NOW);
    const d = deps();
    d.execute = async () => ({ ok: true, http_status: 200, body: {}, recorded: false });
    await fileProposal(db, input(), d);
    expect(d.reports[0]).toMatch(/NOT recorded/);
  });
});
