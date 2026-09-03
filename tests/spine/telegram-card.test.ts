import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import { insertProposal, getProposalById, setTelegramRef, recordExecution } from '../../src/db/proposal-queries.js';
import { getTrustRow } from '../../src/db/trust-queries.js';
import {
  renderProposalCard, buildProposalKeyboard, parseCallbackData, handleProposalCallback,
  handleEditReply, createTelegramTransport, type CardDeps,
} from '../../src/spine/telegram-card.js';

const NOW = '2026-09-07T12:00:00.000Z';

function seed(db: Database.Database, monthlyUsd = 30000): number {
  return insertProposal(db, {
    agent: 'marketing-manager', brand_id: 'dearborn-denim', action_type: 'ad_spend_step',
    action_payload: { hand: 'ad-manager', method: 'POST', path: '/api/spend', body: { monthly_usd: monthlyUsd } },
    reason: 'Matured week read 2.7 marginal ROAS, above the 2.5 scale rule.',
    evidence: { marginal_roas_7d: 2.7, hurdle: 2.45, current_monthly_usd: 15000 },
    cost_usd: 15000, reversible: true, level_required: 1, expires_at: '2026-09-09T00:00:00.000Z',
  }, NOW).id;
}

// The fake executor records the result the way the real one does, so status
// assertions below see 'executed'.
function deps(db: Database.Database, over: Partial<CardDeps> = {}): CardDeps & { executed: number[]; replies: string[] } {
  const executed: number[] = [];
  const replies: string[] = [];
  return {
    now: () => NOW,
    execute: async (id) => { executed.push(id); recordExecution(db, id, 'executed', { http_status: 200 }); return { ok: true, http_status: 200, body: {} }; },
    reply: async (text) => { replies.push(text); },
    executed, replies, ...over,
  };
}

describe('telegram card', () => {
  let db: Database.Database;
  let id: number;
  beforeEach(() => { db = new Database(':memory:'); initializeSchema(db); id = seed(db); setTelegramRef(db, id, '555', 1); });
  afterEach(() => db.close());

  it('renders agent, brand, action, reason, up to three evidence lines, cost', () => {
    const text = renderProposalCard(getProposalById(db, id)!);
    expect(text).toContain('marketing-manager · dearborn-denim');
    expect(text).toContain('ad_spend_step');
    expect(text).toContain('Matured week read');
    expect(text).toContain('marginal_roas_7d: 2.7');
    expect(text).toContain('Cost: $15,000');
    expect(text).toContain(`#${id}`);
    expect(text.split('\n').length).toBeLessThanOrEqual(9);
  });

  it('keyboard carries approve/edit/reject callback data for the id', () => {
    const kb = buildProposalKeyboard(id);
    const data = kb.inline_keyboard.flat().map((b) => (b as { callback_data: string }).callback_data);
    expect(data).toEqual([`prop:approve:${id}`, `prop:edit:${id}`, `prop:reject:${id}`]);
  });

  it('parses callback data and rejects garbage', () => {
    expect(parseCallbackData(`prop:approve:${id}`)).toEqual({ action: 'approve', id });
    expect(parseCallbackData('prop:nuke:1')).toBeNull();
    expect(parseCallbackData('other')).toBeNull();
  });

  it('approve: decides, records trust, executes, replies', async () => {
    const d = deps(db);
    const r = await handleProposalCallback(db, { action: 'approve', id }, 'robert', d);
    expect(r.ok).toBe(true);
    expect(getProposalById(db, id)!.status).toBe('executed');
    expect(d.executed).toEqual([id]);
    expect(getTrustRow(db, { agent: 'marketing-manager', brand_id: 'dearborn-denim', action_type: 'ad_spend_step' })!.approved_as_proposed).toBe(1);
    expect(d.replies[0]).toMatch(/Approved #\d+ — executed/);
  });

  it('reject: decides, records trust, does not execute', async () => {
    const d = deps(db);
    await handleProposalCallback(db, { action: 'reject', id }, 'robert', d);
    expect(getProposalById(db, id)!.status).toBe('rejected');
    expect(d.executed).toEqual([]);
  });

  it('edit: flags the proposal and asks for key=value', async () => {
    const d = deps(db);
    await handleProposalCallback(db, { action: 'edit', id }, 'robert', d);
    expect(getProposalById(db, id)!.edit_requested_at).toBe(NOW);
    expect(d.replies[0]).toMatch(/key=value/);
  });

  it('edit reply: applies fields, approves with edit, executes', async () => {
    const d = deps(db);
    await handleProposalCallback(db, { action: 'edit', id }, 'robert', d);
    const handled = await handleEditReply(db, '555', 'monthly_usd=20000', 'robert', d);
    expect(handled).toBe(true);
    const row = getProposalById(db, id)!;
    expect(row.status).toBe('executed');
    expect(JSON.parse(row.action_payload).body.monthly_usd).toBe(20000);
    expect(JSON.parse(row.edits!)[0].note).toBe('monthly_usd=20000');
    expect(getTrustRow(db, { agent: 'marketing-manager', brand_id: 'dearborn-denim', action_type: 'ad_spend_step' })!.approved_with_edit).toBe(1);
  });

  it('edit reply with bad text keeps waiting and explains', async () => {
    const d = deps(db);
    await handleProposalCallback(db, { action: 'edit', id }, 'robert', d);
    const handled = await handleEditReply(db, '555', 'make it twenty', 'robert', d);
    expect(handled).toBe(true);
    expect(getProposalById(db, id)!.status).toBe('pending');
    expect(d.replies.at(-1)).toMatch(/key=value/);
  });

  it('edit reply from a chat with nothing pending is not handled', async () => {
    const d = deps(db);
    expect(await handleEditReply(db, '999', 'monthly_usd=1', 'robert', d)).toBe(false);
  });

  it('a second edit request in the same chat supersedes the first', async () => {
    const second = seed(db, 40000);
    setTelegramRef(db, second, '555', 2);
    const d = deps(db);
    await handleProposalCallback(db, { action: 'edit', id }, 'robert', d);
    await handleProposalCallback(db, { action: 'edit', id: second }, 'robert', d);
    expect(getProposalById(db, id)!.edit_requested_at).toBeNull();
    expect(getProposalById(db, second)!.edit_requested_at).toBe(NOW);
    expect(await handleEditReply(db, '555', 'monthly_usd=20000', 'robert', d)).toBe(true);
    expect(getProposalById(db, second)!.status).toBe('executed');
    expect(getProposalById(db, id)!.status).toBe('pending');
    expect(d.executed).toEqual([second]);
  });

  it('a decision on an already-decided proposal is refused', async () => {
    const d = deps(db);
    await handleProposalCallback(db, { action: 'reject', id }, 'robert', d);
    const r = await handleProposalCallback(db, { action: 'approve', id }, 'robert', d);
    expect(r.ok).toBe(false);
    expect(d.executed).toEqual([]);
  });

  it('a failed execution after approve reports failure', async () => {
    const d = deps(db, { execute: async () => ({ ok: false, http_status: 500 }) });
    await handleProposalCallback(db, { action: 'approve', id }, 'robert', d);
    expect(d.replies[0]).toMatch(/failed/);
  });

  it('telegram transport attaches the keyboard on cards and not on text', async () => {
    const calls: { chatId: string; text: string; opts?: { reply_markup?: unknown } }[] = [];
    const t = createTelegramTransport({ async sendMessage(chatId, text, opts) { calls.push({ chatId, text, opts }); return { message_id: 7 }; } });
    expect(await t.sendCard('555', 'card', id)).toEqual({ message_id: 7 });
    await t.sendText('555', 'hi');
    expect(calls[0]!.opts?.reply_markup).toBeDefined();
    expect(calls[1]!.opts).toBeUndefined();
  });
});
