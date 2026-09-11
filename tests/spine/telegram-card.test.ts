import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import { insertProposal, getProposalById, setTelegramRef, recordExecution, updateActionPayload } from '../../src/db/proposal-queries.js';
import { getTrustRow } from '../../src/db/trust-queries.js';
import {
  renderProposalCard, buildProposalKeyboard, parseCallbackData, handleProposalCallback,
  handleEditReply, createTelegramTransport, EDIT_WINDOW_MS, type CardDeps,
} from '../../src/spine/telegram-card.js';
import type { ProposalRow } from '../../src/spine/types.js';
import { parseEdit } from '../../src/spine/edits.js';

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

  it('renders an email proposal as the message Robert is approving, not hand/path', () => {
    const emailId = insertProposal(db, {
      agent: 'sourcing', brand_id: 'dearborn-denim', action_type: 'rfq_send',
      action_payload: {
        hand: 'email', method: 'POST', path: '/send',
        body: {
          to: ['sales@carr.example'],
          subject: '[DD-RFQ-linen-carr-20260910] Fabric request — Dearborn Denim, Spring 27',
          text: 'We are after a mid-weight linen for a Spring 27 shirt.',
          attachments: [{ url: 'https://design.example/files/x/linen.png', name: 'linen.png' }],
        },
      },
      reason: 'No house or catalog match for the linen intent.',
      evidence: { rfq_id: 'linen-carr-20260910', intents: 'fi_1,fi_2' },
      cost_usd: 0, reversible: false, level_required: 1, expires_at: '2026-09-12T00:00:00.000Z',
    }, NOW).id;
    const text = renderProposalCard(getProposalById(db, emailId)!);
    expect(text).toContain('rfq_send → email to sales@carr.example');
    expect(text).toContain('Subject: [DD-RFQ-linen-carr-20260910] Fabric request');
    expect(text).toContain('We are after a mid-weight linen');
    expect(text).toContain('1 attachment');
    expect(text).toContain('NOT reversible');
    expect(text).not.toContain('/send');
  });

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

// --- graph hand cards -------------------------------------------------------
// The existing seed() helper inserts a marketing row, so this block builds its
// own ProposalRow literal instead.
function rowFor(over: Partial<ProposalRow>): ProposalRow {
  return {
    id: 42, agent: 'mcsecretary', brand_id: 'dearborn-denim', action_type: 'graph_dispatch',
    action_payload: '{}', payload_hash: 'h', reason: 'r', evidence: '{}', cost_usd: 0,
    reversible: 0, level_required: 1, status: 'pending', created_at: NOW,
    expires_at: '2026-09-13T12:00:00.000Z', decided_by: null, decided_at: null, edits: null,
    edit_requested_at: null, execution_result: null, telegram_chat_id: null,
    telegram_message_id: null, run_id: null, ...over,
  };
}

describe('renderProposalCard for the graph hand', () => {
  const plan = {
    summary: 'Four knit concepts, both lines.',
    briefs: Array.from({ length: 8 }, (_, i) => ({
      collection_name: `Concept ${i}`, line: i % 2 === 0 ? 'mens' : 'womens',
      brief_text: 'x'.repeat(80), season: 'Winter 2026', target_launch: '2026-11-06',
      product_count: 4, price_ladder: ['core'], fabric_locks: ['waffle knit'],
      vendor: 'american-fabrics-international', dye_program: 'pfd_house_dye', persona: 'all',
    })),
    vendor_contacts: [{ vendor_name: 'American Fabrics International', slug: null, contact_name: 'Ned Pilchman', email: 'marteva@hotmail.com', phone: null, sells: null, notes: null }],
    run_requests: [],
  };
  const card = (reason: string) => renderProposalCard(rowFor({
    agent: 'mcsecretary', action_type: 'graph_dispatch', reason,
    action_payload: JSON.stringify({ hand: 'graph', method: 'POST', path: '/dispatch', body: plan }),
  }));

  it('renders every brief line rather than truncating at the 500-char reason cap', () => {
    const text = card('unused');
    expect(text).toContain('Concept 0');
    expect(text).toContain('Concept 7');   // the 500-cap would have cut this
    expect(text).not.toContain('graph/dispatch');
    expect(text).toContain('Contact: American Fabrics International — Ned Pilchman <marteva@hotmail.com>');
  });

  it('leads with the id/agent line, then the summary, and closes with cost and expiry', () => {
    const lines = card('unused').split('\n');
    expect(lines[0]).toMatch(/^#\d+ mcsecretary · dearborn-denim$/);   // no requested_by on this row
    expect(lines[1]).toBe('Four knit concepts, both lines.');
    expect(lines.at(-3)).toBe('Edit: summary=<new text> only — anything deeper, Reject and re-send the message.');
    expect(lines.at(-2)).toContain('NOT reversible');
    expect(lines.at(-1)).toMatch(/^Expires /);
  });

  it('caps the plan block at GRAPH_PLAN_CAP with an ellipsis rather than overflowing Telegram', () => {
    const huge = { ...plan, briefs: Array.from({ length: 8 }, (_, i) => ({ ...plan.briefs[0], collection_name: 'C'.repeat(110) + i, fabric_locks: Array.from({ length: 4 }, (_2, j) => `fabric ${j} ${'f'.repeat(50)}`) })) };
    const text = renderProposalCard(rowFor({
      agent: 'mcsecretary', action_type: 'graph_dispatch', reason: 'unused',
      action_payload: JSON.stringify({ hand: 'graph', method: 'POST', path: '/dispatch', body: huge }),
    }));
    expect(text.length).toBeLessThan(2200);
    expect(text).toContain('…');
  });

  it('falls back to the stored reason when the body is not a readable plan', () => {
    const text = renderProposalCard(rowFor({
      agent: 'mcsecretary', action_type: 'graph_dispatch', reason: 'stored reason text',
      action_payload: JSON.stringify({ hand: 'graph', method: 'POST', path: '/dispatch', body: { junk: true } }),
    }));
    expect(text).toContain('stored reason text');
  });

  it('shows an edited summary, because the card is rendered from the body', () => {
    const edited = { ...plan, summary: 'Only the waffle knit one, please.' };
    const text = renderProposalCard(rowFor({
      action_payload: JSON.stringify({ hand: 'graph', method: 'POST', path: '/dispatch', body: edited }),
    }));
    expect(text.split('\n')[1]).toBe('Only the waffle knit one, please.');
  });

  it('shows the designer-run estimate from the filed evidence, not a guess', () => {
    const text = renderProposalCard(rowFor({
      action_payload: JSON.stringify({ hand: 'graph', method: 'POST', path: '/dispatch', body: plan }),
      evidence: JSON.stringify({ requested_by: 'Robert', briefs: 8, design_runs_estimated: 16 }),
    }));
    expect(text.split('\n').at(-4)).toBe('Estimated 16 designer runs (8 briefs × approved personas).');
  });

  it('falls back to the count already written into the stored reason', () => {
    const text = renderProposalCard(rowFor({
      action_payload: JSON.stringify({ hand: 'graph', method: 'POST', path: '/dispatch', body: plan }),
      evidence: JSON.stringify({ briefs: 8 }),
      reason: 'summary line\nEstimated 16 designer runs (8 briefs × approved personas).',
    }));
    expect(text.split('\n').at(-4)).toBe('Estimated 16 designer runs (8 briefs × approved personas).');
  });

  it('says "per approved persona" when neither evidence nor reason carries a count', () => {
    const text = renderProposalCard(rowFor({
      action_payload: JSON.stringify({ hand: 'graph', method: 'POST', path: '/dispatch', body: plan }),
      evidence: '{}', reason: 'nothing useful',
    }));
    expect(text.split('\n').at(-4)).toBe('Estimated 8 briefs × per approved persona designer runs.');
  });

  it('names the requesting user on the first line', () => {
    const text = renderProposalCard(rowFor({
      action_payload: JSON.stringify({ hand: 'graph', method: 'POST', path: '/dispatch', body: plan }),
      evidence: JSON.stringify({ requested_by: 'Robert', design_runs_estimated: 16 }),
    }));
    expect(text.split('\n')[0]).toBe('#42 mcsecretary · dearborn-denim · for Robert');
  });

  it('shows a truncated brief_text line under each brief for a small dispatch', () => {
    const small = { ...plan, briefs: plan.briefs.slice(0, 2).map((b, i) => ({ ...b, brief_text: `${'b'.repeat(200)}${i}` })) };
    const lines = renderProposalCard(rowFor({
      action_payload: JSON.stringify({ hand: 'graph', method: 'POST', path: '/dispatch', body: small }),
    })).split('\n');
    const textLines = lines.filter((l) => l.startsWith('  b'));
    expect(textLines).toHaveLength(2);
    expect(textLines[0]!.length).toBeLessThanOrEqual(142);
    expect(textLines[0]).toContain('…');
  });

  it('omits the brief_text lines once there are more than three briefs', () => {
    const lines = renderProposalCard(rowFor({
      action_payload: JSON.stringify({ hand: 'graph', method: 'POST', path: '/dispatch', body: plan }),
    })).split('\n');
    expect(lines.filter((l) => l.startsWith('  '))).toEqual([]);
  });

  it('the Edit hint it prints is a line parseEdit actually accepts', () => {
    const hintLine = card('unused').split('\n').at(-3)!;
    expect(hintLine).toContain('summary=');
    const parsed = parseEdit('summary=Only the waffle knit one, both lines');
    expect(parsed.ok).toBe(true);
  });
});
