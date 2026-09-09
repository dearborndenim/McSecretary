import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import { insertProposal, getProposalById, setTelegramRef, recordExecution, updateActionPayload } from '../../src/db/proposal-queries.js';
import { getTrustRow } from '../../src/db/trust-queries.js';
import {
  renderProposalCard, buildProposalKeyboard, parseCallbackData, handleProposalCallback,
  handleEditReply, createTelegramTransport, EDIT_WINDOW_MS, type CardDeps,
} from '../../src/spine/telegram-card.js';

const NOW = '2026-09-07T12:00:00.000Z';

function seed(db: Database.Database, monthlyUsd = 30000, reason = 'Matured week read 2.7 marginal ROAS, above the 2.5 scale rule.'): number {
  return insertProposal(db, {
    agent: 'marketing-manager', brand_id: 'dearborn-denim', action_type: 'ad_spend_step',
    action_payload: { hand: 'ad-manager', method: 'POST', path: '/api/spend', body: { monthly_usd: monthlyUsd } },
    reason,
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

  it('renders a notes proposal with title as headline and summary as body', () => {
    const notesId = insertProposal(db, {
      agent: 'ops-agent', brand_id: 'dearborn-denim', action_type: 'capacity_warning',
      action_payload: { hand: 'notes', method: 'POST', path: '/note', body: { title: 'Line 2 at capacity', summary: 'Utilization hit 92% this week.' } },
      reason: 'irrelevant technical reason', evidence: { should_not: 'appear' },
      cost_usd: 0, reversible: true, level_required: 1, expires_at: '2026-09-09T00:00:00.000Z',
    }, NOW).id;
    const text = renderProposalCard(getProposalById(db, notesId)!);
    expect(text).toContain(`#${notesId}`);
    expect(text).toContain('Line 2 at capacity');
    expect(text).toContain('Utilization hit 92% this week.');
    expect(text).toContain('Cost: $0');
    expect(text).not.toContain('capacity_warning →');
    expect(text).not.toContain('should_not');
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
    const r = await handleProposalCallback(db, { action: 'approve', id }, '555', 'robert', d);
    expect(r.ok).toBe(true);
    expect(getProposalById(db, id)!.status).toBe('executed');
    expect(d.executed).toEqual([id]);
    expect(getTrustRow(db, { agent: 'marketing-manager', brand_id: 'dearborn-denim', action_type: 'ad_spend_step' })!.approved_as_proposed).toBe(1);
    expect(d.replies[0]).toMatch(/Approved #\d+ — executed/);
  });

  it('approve: appends the hand\'s notify field to the reply', async () => {
    const d = deps(db, {
      execute: async (pid) => {
        recordExecution(db, pid, 'executed', { http_status: 200 });
        return { ok: true, http_status: 200, body: { notify: 'Spend live at $20k/mo.' } };
      },
    });
    await handleProposalCallback(db, { action: 'approve', id }, '555', 'robert', d);
    expect(d.replies[0]).toBe(`Approved #${id} — executed (200). Spend live at $20k/mo.`);
  });

  it('approve: leaves the reply unchanged when notify is absent', async () => {
    const d = deps(db);
    await handleProposalCallback(db, { action: 'approve', id }, '555', 'robert', d);
    expect(d.replies[0]).toBe(`Approved #${id} — executed (200).`);
  });

  it('approve: truncates an over-long notify field to 600 chars', async () => {
    const long = 'z'.repeat(700);
    const d = deps(db, {
      execute: async (pid) => {
        recordExecution(db, pid, 'executed', { http_status: 200 });
        return { ok: true, http_status: 200, body: { notify: long } };
      },
    });
    await handleProposalCallback(db, { action: 'approve', id }, '555', 'robert', d);
    expect(d.replies[0]).toBe(`Approved #${id} — executed (200). ${'z'.repeat(600)}`);
  });

  it('approve: ignores a non-string notify field', async () => {
    const d = deps(db, {
      execute: async (pid) => {
        recordExecution(db, pid, 'executed', { http_status: 200 });
        return { ok: true, http_status: 200, body: { notify: { nested: true } } };
      },
    });
    await handleProposalCallback(db, { action: 'approve', id }, '555', 'robert', d);
    expect(d.replies[0]).toBe(`Approved #${id} — executed (200).`);
  });

  it('reject: decides, records trust, does not execute', async () => {
    const d = deps(db);
    await handleProposalCallback(db, { action: 'reject', id }, '555', 'robert', d);
    expect(getProposalById(db, id)!.status).toBe('rejected');
    expect(d.executed).toEqual([]);
  });

  it('edit: flags the proposal and asks for key=value', async () => {
    const d = deps(db);
    await handleProposalCallback(db, { action: 'edit', id }, '555', 'robert', d);
    expect(getProposalById(db, id)!.edit_requested_at).toBe(NOW);
    expect(d.replies[0]).toMatch(/key=value/);
    expect(d.replies[0]).toMatch(/cancel/);
  });

  it('edit reply: applies fields, approves with edit, executes', async () => {
    const d = deps(db);
    await handleProposalCallback(db, { action: 'edit', id }, '555', 'robert', d);
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
    await handleProposalCallback(db, { action: 'edit', id }, '555', 'robert', d);
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
    await handleProposalCallback(db, { action: 'edit', id }, '555', 'robert', d);
    await handleProposalCallback(db, { action: 'edit', id: second }, '555', 'robert', d);
    expect(getProposalById(db, id)!.edit_requested_at).toBeNull();
    expect(getProposalById(db, second)!.edit_requested_at).toBe(NOW);
    expect(await handleEditReply(db, '555', 'monthly_usd=20000', 'robert', d)).toBe(true);
    expect(getProposalById(db, second)!.status).toBe('executed');
    expect(getProposalById(db, id)!.status).toBe('pending');
    expect(d.executed).toEqual([second]);
  });

  it('a decision on an already-decided proposal is refused', async () => {
    const d = deps(db);
    await handleProposalCallback(db, { action: 'reject', id }, '555', 'robert', d);
    const r = await handleProposalCallback(db, { action: 'approve', id }, '555', 'robert', d);
    expect(r.ok).toBe(false);
    expect(d.executed).toEqual([]);
  });

  it('a failed execution after approve reports failure', async () => {
    const d = deps(db, { execute: async () => ({ ok: false, http_status: 500 }) });
    await handleProposalCallback(db, { action: 'approve', id }, '555', 'robert', d);
    expect(d.replies[0]).toMatch(/failed/);
  });

  it('caps a runaway reason and evidence values so the card stays phone-sized', () => {
    const long = seed(db, 1, 'x'.repeat(2000));
    db.prepare('UPDATE proposals SET evidence = ? WHERE id = ?').run(JSON.stringify({ note: 'y'.repeat(500), n: 1 }), long);
    const text = renderProposalCard(getProposalById(db, long)!);
    expect(text.length).toBeLessThan(1000);
    expect(text).toContain('Cost: $1');
    expect(text.split('\n').find((l) => l.startsWith('  note:'))!.length).toBeLessThanOrEqual(90);
  });

  it('renders no evidence lines when evidence is not an object', () => {
    db.prepare('UPDATE proposals SET evidence = ? WHERE id = ?').run('"just a string"', id);
    const text = renderProposalCard(getProposalById(db, id)!);
    expect(text.split('\n')).toHaveLength(5);
  });

  it('a tap from another chat is refused with no writes', async () => {
    const d = deps(db);
    const r = await handleProposalCallback(db, { action: 'approve', id }, '999', 'mallory', d);
    expect(r).toEqual({ ok: false, message: 'Not your proposal' });
    const row = getProposalById(db, id)!;
    expect(row.status).toBe('pending');
    expect(row.decided_by).toBeNull();
    expect(d.executed).toEqual([]);
    expect(d.replies).toEqual([]);
    expect(getTrustRow(db, { agent: 'marketing-manager', brand_id: 'dearborn-denim', action_type: 'ad_spend_step' })).toBeUndefined();
  });

  it('a double-tap on approve executes once and counts once', async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    const d = deps(db, {
      execute: async (pid) => {
        await gate;
        recordExecution(db, pid, 'executed', { http_status: 200 });
        return { ok: true, http_status: 200, body: {} };
      },
    });
    const executeSpy = vi.fn(d.execute);
    d.execute = executeSpy;
    const both = Promise.all([
      handleProposalCallback(db, { action: 'approve', id }, '555', 'robert', d),
      handleProposalCallback(db, { action: 'approve', id }, '555', 'robert', d),
    ]);
    release();
    const [a, b] = await both;
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect(getTrustRow(db, { agent: 'marketing-manager', brand_id: 'dearborn-denim', action_type: 'ad_spend_step' })!.approved_as_proposed).toBe(1);
    expect(getProposalById(db, id)!.status).toBe('executed');
  });

  it('a decision that lands between the read and the claim is refused without trust or execution', async () => {
    // deps.now() is the first thing approveAndExecute calls after the read;
    // use it to simulate a concurrent rejection on another connection.
    const d = deps(db, {
      now: () => { db.prepare("UPDATE proposals SET status = 'rejected' WHERE id = ?").run(id); return NOW; },
    });
    const r = await handleProposalCallback(db, { action: 'approve', id }, '555', 'robert', d);
    expect(r).toEqual({ ok: false, message: `#${id} was already decided` });
    expect(d.executed).toEqual([]);
    expect(getTrustRow(db, { agent: 'marketing-manager', brand_id: 'dearborn-denim', action_type: 'ad_spend_step' })).toBeUndefined();
    expect(d.replies[0]).toBe(`#${id} was already decided.`);
    expect(getProposalById(db, id)!.status).toBe('rejected');
  });

  it('a reply transport failure does not block the decision or execution', async () => {
    const d = deps(db, { reply: async () => { throw new Error('telegram down'); } });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await handleProposalCallback(db, { action: 'approve', id }, '555', 'robert', d);
    err.mockRestore();
    expect(r.ok).toBe(true);
    expect(getProposalById(db, id)!.status).toBe('executed');
    expect(d.executed).toEqual([id]);
  });

  it('edit reply "cancel" clears the edit flag and leaves the proposal pending', async () => {
    const d = deps(db);
    await handleProposalCallback(db, { action: 'edit', id }, '555', 'robert', d);
    expect(await handleEditReply(db, '555', ' Cancel ', 'robert', d)).toBe(true);
    const row = getProposalById(db, id)!;
    expect(row.status).toBe('pending');
    expect(row.edit_requested_at).toBeNull();
    expect(d.replies.at(-1)).toBe(`Edit cancelled. #${id} is still pending.`);
    expect(await handleEditReply(db, '555', 'monthly_usd=1', 'robert', d)).toBe(false);
    expect(d.executed).toEqual([]);
  });

  it('an edit request older than the window is dropped and the message falls through', async () => {
    const d = deps(db);
    await handleProposalCallback(db, { action: 'edit', id }, '555', 'robert', d);
    const later = new Date(Date.parse(NOW) + EDIT_WINDOW_MS + 1000).toISOString();
    const stale = deps(db, { now: () => later });
    expect(await handleEditReply(db, '555', 'monthly_usd=20000', 'robert', stale)).toBe(false);
    const row = getProposalById(db, id)!;
    expect(row.status).toBe('pending');
    expect(row.edit_requested_at).toBeNull();
    expect(JSON.parse(row.action_payload).body.monthly_usd).toBe(30000);
    expect(stale.replies).toEqual([]);
  });

  it('an edit reply inside the window is still applied', async () => {
    const d = deps(db);
    await handleProposalCallback(db, { action: 'edit', id }, '555', 'robert', d);
    const within = deps(db, { now: () => new Date(Date.parse(NOW) + EDIT_WINDOW_MS - 1000).toISOString() });
    expect(await handleEditReply(db, '555', 'monthly_usd=20000', 'robert', within)).toBe(true);
    expect(getProposalById(db, id)!.status).toBe('executed');
  });

  it('updating the payload after an edit changes the dedupe hash', () => {
    const before = getProposalById(db, id)!.payload_hash;
    updateActionPayload(db, id, { hand: 'ad-manager', method: 'POST', path: '/api/spend', body: { monthly_usd: 20000 } });
    expect(getProposalById(db, id)!.payload_hash).not.toBe(before);
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
