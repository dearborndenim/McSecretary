import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import { getProposalById } from '../../src/db/proposal-queries.js';
import { promoteTrust } from '../../src/db/trust-queries.js';
import { fileProposal, type RouterDeps } from '../../src/spine/router.js';
import { executeProposal } from '../../src/spine/executor.js';
import type { ProposalInput } from '../../src/spine/types.js';
import type { BrandConfig } from '../../src/spine/brand-config.js';

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

  it('level 2 notes: auto-executes via the built-in hand short-circuit and reports the title/summary fallback', async () => {
    const notesK = { agent: 'ops-agent', brand_id: 'dearborn-denim', action_type: 'capacity_warning' };
    promoteTrust(db, notesK, 2, 'robert', NOW);
    const noHandsBrand: BrandConfig = {
      brand_id: 'dearborn-denim', display_name: 'DD', inbox_user_id: 'robert-mcmillan',
      shopify_store: 's', meta_ad_account: 'm', silent_budget_usd: 500, exploration_share: 0.2,
      proposal_expiry_hours: 48, hands: {},
    };
    const d = deps();
    d.execute = (id) => executeProposal(db, id, { fetch: vi.fn(), env: {}, loadBrand: () => noHandsBrand, now: () => NOW });
    const r = await fileProposal(db, input({
      ...notesK,
      action_payload: { hand: 'notes', method: 'POST', path: '/note', body: { title: 'Line 2 at capacity', summary: 'Utilization hit 92% this week.' } },
    }), d);
    expect(r.routed).toBe('executed');
    expect(getProposalById(db, r.id)!.status).toBe('executed');
    expect(d.reports[0]).toContain('Line 2 at capacity: Utilization hit 92% this week.');
  });

  it('level 2 notes: reports an explicit notify over the title/summary fallback', async () => {
    const notesK = { agent: 'ops-agent', brand_id: 'dearborn-denim', action_type: 'schedule_change' };
    promoteTrust(db, notesK, 2, 'robert', NOW);
    const noHandsBrand: BrandConfig = {
      brand_id: 'dearborn-denim', display_name: 'DD', inbox_user_id: 'robert-mcmillan',
      shopify_store: 's', meta_ad_account: 'm', silent_budget_usd: 500, exploration_share: 0.2,
      proposal_expiry_hours: 48, hands: {},
    };
    const d = deps();
    d.execute = (id) => executeProposal(db, id, { fetch: vi.fn(), env: {}, loadBrand: () => noHandsBrand, now: () => NOW });
    const r = await fileProposal(db, input({
      ...notesK,
      action_payload: { hand: 'notes', method: 'POST', path: '/note', body: { title: 't', summary: 's', notify: 'Schedule moved to Thursday.' } },
    }), d);
    expect(r.routed).toBe('executed');
    expect(d.reports[0]).toContain('Schedule moved to Thursday.');
  });

  it('level 3: executes silently when reversible and under budget', async () => {
    promoteTrust(db, K, 3, 'robert', NOW);
    const d = deps();
    const r = await fileProposal(db, input({ cost_usd: 100 }), d);
    expect(r.routed).toBe('executed_silent');
    expect(d.reports).toEqual([]);
  });

  it('level 3 notes: a note is inherently reversible at $0 cost, so promotion makes it silent', async () => {
    const notesK = { agent: 'ops-agent', brand_id: 'dearborn-denim', action_type: 'variance_report' };
    promoteTrust(db, notesK, 3, 'robert', NOW);
    const noHandsBrand: BrandConfig = {
      brand_id: 'dearborn-denim', display_name: 'DD', inbox_user_id: 'robert-mcmillan',
      shopify_store: 's', meta_ad_account: 'm', silent_budget_usd: 500, exploration_share: 0.2,
      proposal_expiry_hours: 48, hands: {},
    };
    const d = deps();
    d.execute = (id) => executeProposal(db, id, { fetch: vi.fn(), env: {}, loadBrand: () => noHandsBrand, now: () => NOW });
    const r = await fileProposal(db, input({
      ...notesK, cost_usd: 0, reversible: true,
      action_payload: { hand: 'notes', method: 'POST', path: '/note', body: { title: 't', summary: 's' } },
    }), d);
    expect(r.routed).toBe('executed_silent');
    expect(d.cards).toEqual([]);
    expect(d.reports).toEqual([]);
    expect(getProposalById(db, r.id)!.status).toBe('executed');
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
    expect(getProposalById(db, r.id)!.telegram_chat_id).toBeNull();
  });

  it('re-filing a pending duplicate whose card never landed re-sends the card', async () => {
    const d = deps();
    const good = d.sendCard;
    d.sendCard = async () => { throw new Error('telegram down'); };
    const a = await fileProposal(db, input(), d);
    expect(a.routed).toBe('card_failed');
    d.sendCard = good;
    const b = await fileProposal(db, input(), d);
    expect(b.id).toBe(a.id);
    expect(b.routed).toBe('card');
    expect(d.cards).toEqual([a.id]);
    const row = getProposalById(db, a.id)!;
    expect(row.telegram_chat_id).toBe('555');
    expect(row.telegram_message_id).toBe(42);
  });

  it('a failed auto-execution routes as execution_failed and reports', async () => {
    promoteTrust(db, K, 2, 'robert', NOW);
    const d = deps();
    d.execute = async () => ({ ok: false, http_status: 503 });
    const r = await fileProposal(db, input(), d);
    expect(r.routed).toBe('execution_failed');
    expect(d.reports[0]).toMatch(/failed \(503\)/);
  });

  it('a level-2 execution that the hand accepted but the row did not record is reported loudly', async () => {
    promoteTrust(db, K, 2, 'robert', NOW);
    const d = deps();
    d.execute = async () => ({ ok: true, http_status: 200, body: {}, recorded: false });
    await fileProposal(db, input(), d);
    expect(d.reports[0]).toMatch(/NOT recorded/);
  });

  it('appends the hand\'s notify field to the executed report', async () => {
    promoteTrust(db, K, 2, 'robert', NOW);
    const d = deps();
    d.execute = async () => ({ ok: true, http_status: 200, body: { notify: 'Budget raised to $12k.' } });
    const r = await fileProposal(db, input(), d);
    expect(r.routed).toBe('executed');
    expect(d.reports[0]).toBe(`Executed #${r.id} marketing-manager creative_request (level 2, 200). Budget raised to $12k.`);
  });

  it('leaves the executed report unchanged when notify is absent', async () => {
    promoteTrust(db, K, 2, 'robert', NOW);
    const d = deps();
    // deps() default execute already returns body: {} with no notify.
    const r = await fileProposal(db, input(), d);
    expect(d.reports[0]).toBe(`Executed #${r.id} marketing-manager creative_request (level 2, 200).`);
  });

  it('truncates an over-long notify field to 600 chars', async () => {
    promoteTrust(db, K, 2, 'robert', NOW);
    const d = deps();
    const long = 'y'.repeat(700);
    d.execute = async () => ({ ok: true, http_status: 200, body: { notify: long } });
    await fileProposal(db, input(), d);
    expect(d.reports[0]).toContain('y'.repeat(600));
    expect(d.reports[0]).not.toContain('y'.repeat(601));
  });

  it('ignores a non-string notify field on the executed report', async () => {
    promoteTrust(db, K, 2, 'robert', NOW);
    const d = deps();
    d.execute = async () => ({ ok: true, http_status: 200, body: { notify: 12345 } });
    const r = await fileProposal(db, input(), d);
    expect(d.reports[0]).toBe(`Executed #${r.id} marketing-manager creative_request (level 2, 200).`);
  });
});
