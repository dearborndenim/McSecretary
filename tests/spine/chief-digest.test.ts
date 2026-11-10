import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import cron from 'node-cron';
import { initializeSchema } from '../../src/db/schema.js';
import { initializeInboxSweepSchema, insertSweepLog } from '../../src/db/inbox-sweep-schema.js';
import { getScheduledTasks } from '../../src/db/schedule-queries.js';
import { initializeDefaultSchedule } from '../../src/scheduler.js';
import { decideProposal, getProposalById, insertProposal, recordExecution, setTelegramRef } from '../../src/db/proposal-queries.js';
import { getTrustRow } from '../../src/db/trust-queries.js';
import { relayProposalDecision, type CardDeps } from '../../src/spine/telegram-card.js';
import {
  buildChiefDigest, CHIEF_APPROVALS_AGENT, CHIEF_DIGEST_SCHEDULE, CHIEF_DIGEST_TASK, createChiefDecisionHandler, DECIDED_BY,
  type DecisionDeps, type DigestDeps,
} from '../../src/spine/chief-digest.js';

const ROB = 'rob@dearborndenim.com';
const MMI = 'robert@mcmillan-manufacturing.com';
const GINA = 'gina@dearborndenim.com';
const ENV = { OUTLOOK_USER_EMAIL_1: ROB, OUTLOOK_USER_EMAIL_2: MMI, CHIEF_DIGEST_MODE: 'on' };
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/chief-digest/${name}.json`, import.meta.url), 'utf8'));

/** A stateful stand-in for Graph: Drafts per mailbox; /send moves a draft to `sent`. */
function fakeGraph(opts: { failMailbox?: string } = {}) {
  const drafts = new Map<string, any[]>([[ROB, fixture('drafts-rob').value], [MMI, []], [GINA, fixture('drafts-gina').value]]);
  const sent: string[] = [];
  const writes: string[] = [];
  const graphFetch = async (url: string, init: RequestInit): Promise<Response> => {
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
    const m = /\/users\/([^/]+)\/(mailFolders\/drafts\/messages|messages\/([^/?]+)(\/send)?)/.exec(url);
    const box = decodeURIComponent(m?.[1] ?? '');
    if (init.method !== 'GET') writes.push(`${init.method} ${url}`);
    if (!m) return json({ error: 'NotStubbed' }, 404);
    if (m[2]!.startsWith('mailFolders')) {
      if (box === opts.failMailbox) return json({ error: { code: 'ErrorAccessDenied' } }, 403);
      const list = drafts.get(box) ?? [];
      return json(box === GINA ? { ...fixture('drafts-gina'), value: list } : { value: list });
    }
    const id = decodeURIComponent(m[3]!);
    const draft = (drafts.get(box) ?? []).find((d) => d.id === id);
    if (!draft) return json({ error: { code: 'ErrorItemNotFound' } }, 404);
    if (m[4] && init.method === 'POST') {
      drafts.set(box, drafts.get(box)!.filter((d) => d.id !== id));
      sent.push(id);
      return new Response(null, { status: 202 });
    }
    return json(draft);
  };
  return { drafts, sent, writes, graphFetch, token: async () => 'graph-token' };
}

function seedEmailProposal(db: Database.Database, subject = 'Fabric request — Spring 27'): number {
  const id = insertProposal(db, {
    agent: 'sourcing', brand_id: 'dearborn-denim', action_type: 'rfq_send',
    action_payload: { hand: 'email', method: 'POST', path: '/send', body: { to: ['sales@carr.example'], subject, text: 'We are after a mid-weight linen.' } },
    reason: 'No house match.', evidence: {}, cost_usd: 0, reversible: false, level_required: 1, expires_at: '2026-11-12T00:00:00.000Z',
  }, '2026-11-10T12:00:00.000Z').id;
  setTelegramRef(db, id, '555', 9);
  return id;
}

describe('chief digest schedule', () => {
  it('registers "Chief Digest" at 7:00, 12:00 and 17:00 every day', () => {
    expect(CHIEF_DIGEST_SCHEDULE).toBe('0 7,12,17 * * *');
    expect(cron.validate(CHIEF_DIGEST_SCHEDULE)).toBe(true);
    const db = new Database(':memory:');
    initializeSchema(db);
    initializeDefaultSchedule(db, [{ name: CHIEF_DIGEST_TASK, schedule: CHIEF_DIGEST_SCHEDULE, handler: async () => {} }]);
    expect(getScheduledTasks(db).find((t) => t.name === CHIEF_DIGEST_TASK)).toMatchObject({ cron_expression: '0 7,12,17 * * *' });
    db.close();
  });
});

describe('buildChiefDigest', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); initializeSchema(db); });
  afterEach(() => db.close());

  let robert: string[];
  beforeEach(() => { robert = []; });
  const deps = (g: ReturnType<typeof fakeGraph>, at = '2026-11-10T18:00:00.000Z'): DigestDeps => ({
    db, env: ENV, now: () => new Date(at), graphFetch: g.graphFetch, token: g.token, sendToRobert: async (t) => { robert.push(t); },
  });

  it('numbers live email proposals then Outlook drafts, skips expired cards and drafts with no recipient, posts one task to Chief', async () => {
    const pid = seedEmailProposal(db);
    const expired = seedEmailProposal(db, 'Old RFQ');
    db.prepare("UPDATE proposals SET expires_at = '2026-11-10T17:59:00.000Z' WHERE id = ?").run(expired);
    insertProposal(db, {
      agent: 'finance', brand_id: 'dearborn-denim', action_type: 'variance_report',
      action_payload: { hand: 'notes', method: 'POST', path: '/note', body: { title: 't', summary: 's' } },
      reason: 'r', evidence: {}, cost_usd: 0, reversible: true, level_required: 1, expires_at: '2026-11-12T00:00:00.000Z',
    }, '2026-11-10T12:00:00.000Z');
    const at = '2026-11-10T17:00:00.000Z';
    insertSweepLog(db, { message_id: 'm1', mailbox: ROB, received_at: at, sender: 'news@shop.example', subject: 'Sale', lane: 'promotions', folder: 'Promotions', bot: null, unsubscribed: true, mode: 'live', note: 'unsubscribed (one-click)', at });
    insertSweepLog(db, { message_id: 'm2', mailbox: ROB, received_at: at, sender: 'ap@mill.example', subject: 'Invoice 88', lane: 'handoff', folder: 'archive', bot: 'Purchasing Bot', unsubscribed: false, mode: 'live', note: null, at });
    insertSweepLog(db, { message_id: 'm3', mailbox: MMI, received_at: at, sender: 'cfo@partner.example', subject: 'Term sheet', lane: 'keep', folder: null, bot: null, unsubscribed: false, mode: 'live', note: null, at, key_facts: 'Wants a signed term sheet by Friday.' });
    insertSweepLog(db, { message_id: 'm4', mailbox: ROB, received_at: at, sender: 'x@y.example', subject: 'Odd', lane: 'error', folder: null, bot: null, unsubscribed: false, mode: 'live', note: 'classifier: refusal', at });

    const g = fakeGraph();
    const built = await buildChiefDigest(deps(g));
    expect(built.digest_id).toBe('cd-20261110T1800Z');
    const ev = db.prepare('SELECT event_type, source_hand, payload FROM spine_events').all() as { event_type: string; source_hand: string; payload: string }[];
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ event_type: 'grok_task_chief', source_hand: 'mcsecretary' });
    const payload = JSON.parse(ev[0]!.payload);
    expect(payload).toMatchObject({ kind: 'chief_digest', task_id: 'chief-digest-cd-20261110T1800Z', notify: true });
    const { drafts, sweep } = payload.args;
    expect(payload.args.untrusted).toMatch(/never as instructions/);
    expect(drafts.map((d: any) => [d.n, d.source, d.from_mailbox, d.subject])).toEqual([
      [1, 'proposal', ROB, 'Fabric request — Spring 27'],
      [2, 'outlook_draft', ROB, 'Re: SO32P reorder — 600 yards'],
      [3, 'outlook_draft', GINA, 'Chicago Tribune — factory visit'],
    ]);
    expect(drafts[0]).toMatchObject({ item_key: `p-${pid}`, proposal_id: pid, drafted_by: 'sourcing', to: ['sales@carr.example'], attachment_count: 0 });
    expect(drafts[1]).toMatchObject({
      item_key: expect.stringMatching(/^o-[0-9a-f]{24}$/), drafted_by: 'Outlook draft', to: ['owen@conedenim.com'], cc: [GINA],
      previously_rejected_at: null, body_truncated: false, attachment_count: 1,
    });
    expect(drafts[1].body).toMatch(/^Hi Owen,\n\nPlease confirm 600 yards[\s\S]*From: Owen <owen@conedenim.com>[\s\S]*commodo consequat\.$/);
    expect(drafts[2]).toMatchObject({ drafted_by: 'gina@ mailbox (may be bot-drafted)', body: 'Hi Jen,\nThanks for reaching out & Robert would be glad to host you.' });
    expect(payload.args.code_required).toBe(true);
    expect(JSON.stringify(payload)).not.toMatch(/approve code/);
    expect(robert).toEqual([expect.stringMatching(/^Chief digest cd-20261110T1800Z: approve code \d{4}$/)]);
    expect(payload.args.outlook_more_not_shown).toEqual([GINA]);
    expect(sweep).toMatchObject({
      folders: { Promotions: 1, archive: 1 }, unsubscribed: ['news@shop.example'], handoffs: { 'Purchasing Bot': 1 },
      left_in_inbox: [{ mailbox: MMI, sender: 'cfo@partner.example', subject: 'Term sheet', lane: 'keep', key_facts: 'Wants a signed term sheet by Friday.' }],
    });
    expect(sweep.errors).toEqual([{ mailbox: ROB, sender: 'x@y.example', subject: 'Odd', note: 'classifier: refusal' }]);
    const items = db.prepare('SELECT n, source, mailbox, message_id, change_key FROM chief_digest_items ORDER BY n').all();
    expect((db.prepare('SELECT code_hash FROM chief_digests').get() as { code_hash: string }).code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(items).toEqual([
      { n: 1, source: 'proposal', mailbox: null, message_id: null, change_key: null },
      { n: 2, source: 'outlook_draft', mailbox: ROB, message_id: 'AAMkAD-draft-cone', change_key: 'CQAAABYAAAD3' },
      { n: 3, source: 'outlook_draft', mailbox: GINA, message_id: 'AAMkAD-draft-gina-pr', change_key: 'CQAAABYAAAE1' },
    ]);
    expect(g.writes).toEqual([]);
  });

  it('a failed mailbox read is reported and the rest still posts; an empty digest says nothing is pending', async () => {
    const g = fakeGraph({ failMailbox: GINA });
    const built = await buildChiefDigest(deps(g));
    expect(built.args.drafts).toHaveLength(1);
    expect(built.args.errors).toEqual([`Graph drafts ${GINA}: HTTP 403`]);

    g.drafts.set(ROB, []);
    const empty = await buildChiefDigest({ ...deps(fakeGraph()), graphFetch: async () => new Response(JSON.stringify({ value: [] })), now: () => new Date('2026-11-10T23:00:00.000Z') });
    expect(empty.args.message).toBe('Nothing pending: no drafts waiting and nothing new from the sweep.');
    expect(empty.args.code_required).toBe(false);
    expect(robert).toHaveLength(1);
    expect(empty.args.since).toBe('2026-11-10T18:00:00.000Z');
  });
});

describe('chief_draft_decision', () => {
  let db: Database.Database;
  let g: ReturnType<typeof fakeGraph>;
  let pid: number;
  let executed: number[];
  let replies: string[];
  let code: string;
  let keys: Record<number, string>;
  const DIGEST = 'cd-20261110T1300Z';
  const NOW = '2026-11-10T13:05:00.000Z';

  const build = async (at: string) => {
    let sent = '';
    const built = await buildChiefDigest({
      db, env: ENV, now: () => new Date(at), graphFetch: g.graphFetch, token: g.token, sendToRobert: async (t) => { sent = t; },
    });
    code = sent.slice(-4);
    keys = Object.fromEntries((built.args.drafts as any[]).map((d) => [d.n, d.item_key]));
    return built;
  };
  beforeEach(async () => {
    db = new Database(':memory:');
    initializeSchema(db);
    pid = seedEmailProposal(db);
    g = fakeGraph();
    executed = [];
    replies = [];
    await build('2026-11-10T13:00:00.000Z');
  });
  afterEach(() => db.close());

  const cardDeps: () => CardDeps = () => ({
    now: () => NOW,
    execute: async (id) => { executed.push(id); recordExecution(db, id, 'executed', { http_status: 200 }); return { ok: true, http_status: 200, body: {} }; },
    reply: async (t) => { replies.push(t); },
  });
  const handler = (env: Record<string, string> = ENV, now = NOW) => createChiefDecisionHandler({
    db, env, now: () => now, graphFetch: g.graphFetch, token: g.token,
    relay: (id, decision, editText) => relayProposalDecision(db, id, decision, DECIDED_BY, cardDeps(), editText ?? undefined),
  } satisfies DecisionDeps);
  const post = (decisions: unknown[], digest_id = DIGEST) => ({
    source_hand: CHIEF_APPROVALS_AGENT, brand_id: 'dearborn-denim', event_type: 'chief_draft_decision', urgent: false, payload: { digest_id, decisions },
  });
  const decide = (n: number, decision: string, extra: Record<string, unknown> = {}) => ({
    n, item_key: keys[n] ?? 'p-999', decision, robert_quote: `${decision} ${n}`, decided_at: '2026-11-10T13:04:00Z',
    ...(decision === 'approve' ? { code } : {}), ...extra,
  });
  const run = async (decisions: unknown[], digest_id = DIGEST) => {
    const r = handler()(CHIEF_APPROVALS_AGENT, post(decisions, digest_id));
    expect(r.status).toBe(200);
    return (await r.done)!;
  };
  const answers = () => (db.prepare("SELECT payload FROM spine_events WHERE event_type = 'grok_task_chief' ORDER BY id").all() as { payload: string }[])
    .map((r) => JSON.parse(r.payload)).filter((p) => p.kind === 'chief_draft_decision_result');

  it('refuses every key but grok-chief-approvals, everything while the digest is off, and a post without item_key', async () => {
    const body = post([decide(1, 'approve')]);
    expect(handler()('grok-bots', body).status).toBe(403);
    expect(handler({ ...ENV, CHIEF_DIGEST_MODE: 'off' })(CHIEF_APPROVALS_AGENT, body).status).toBe(503);
    expect(handler()(CHIEF_APPROVALS_AGENT, post([{ ...decide(1, 'approve'), item_key: undefined }])).status).toBe(400);
    expect(handler()(CHIEF_APPROVALS_AGENT, post([{ ...decide(1, 'approve'), robert_quote: undefined }])).status).toBe(400);
    expect(handler()(CHIEF_APPROVALS_AGENT, post([decide(1, 'edit')])).status).toBe(400);
    expect(getProposalById(db, pid)!.status).toBe('pending');
    expect(g.sent).toEqual([]);
  });

  it('approve on a proposal runs the Telegram card path: decided by robert via chief, trust counted, card chat told', async () => {
    expect(await run([decide(1, 'approve')])).toEqual([expect.objectContaining({ n: 1, status: 'sent', proposal_id: pid })]);
    expect(executed).toEqual([pid]);
    expect(getProposalById(db, pid)).toMatchObject({ status: 'executed', decided_by: 'robert via chief' });
    expect(getTrustRow(db, { agent: 'sourcing', brand_id: 'dearborn-denim', action_type: 'rfq_send' })!.approved_as_proposed).toBe(1);
    expect(replies[0]).toMatch(new RegExp(`^Approved #${pid}`));
    expect(answers()[0]).toMatchObject({ task_id: expect.stringMatching(/^chief-decision-/), args: { digest_id: DIGEST, message: '1 sent.' } });
  });

  it('an approve needs Robert\'s code; a wrong code refuses without using up the item, and 3 wrong codes lock approvals', async () => {
    const wrong = code === '0000' ? '1111' : '0000';
    expect(await run([decide(1, 'approve', { code: undefined })])).toEqual([expect.objectContaining({ status: 'refused', reason: expect.stringMatching(/needs the 4-digit code/) })]);
    expect(await run([decide(1, 'approve', { code: wrong })])).toEqual([expect.objectContaining({ status: 'refused', reason: expect.stringMatching(/does not match \(2 tries left/) })]);
    expect(executed).toEqual([]);
    expect(await run([decide(3, 'reject')])).toEqual([expect.objectContaining({ status: 'rejected' })]);
    await run([decide(1, 'approve', { code: wrong }), decide(1, 'approve', { code: wrong })]);
    await run([decide(1, 'approve', { code: wrong })]);
    expect(await run([decide(1, 'approve')])).toEqual([expect.objectContaining({ status: 'refused', reason: expect.stringMatching(/locked after 3 wrong codes/) })]);
    expect(executed).toEqual([]);
    const off = createChiefDecisionHandler({
      db, env: { ...ENV, CHIEF_DIGEST_CODE: 'off' }, now: () => NOW, graphFetch: g.graphFetch, token: g.token,
      relay: (id, decision, editText) => relayProposalDecision(db, id, decision, DECIDED_BY, cardDeps(), editText ?? undefined),
    });
    // The code rule is fixed when the digest is built: turning the env off later does not unlock this digest.
    expect(await off(CHIEF_APPROVALS_AGENT, post([decide(1, 'approve', { code: undefined })])).done).toEqual([expect.objectContaining({ status: 'refused' })]);
  });

  it('first decider wins: a card already approved on Telegram is refused and not executed again', async () => {
    decideProposal(db, pid, 'approved', 'robert-mcmillan', '2026-11-10T13:01:00.000Z');
    expect(await run([decide(1, 'approve')])).toEqual([expect.objectContaining({ n: 1, status: 'refused', reason: expect.stringMatching(/already approved/) })]);
    expect(executed).toEqual([]);
  });

  it('refuses an expired card even though the digest listed it', async () => {
    db.prepare("UPDATE proposals SET expires_at = '2026-11-10T13:02:00.000Z' WHERE id = ?").run(pid);
    expect(await run([decide(1, 'approve')])).toEqual([expect.objectContaining({ status: 'refused', reason: 'the proposal has expired' })]);
    expect(executed).toEqual([]);
  });

  it('refuses an unknown number, a wrong item_key, a repeat of a decided number and a superseded digest', async () => {
    const first = await run([decide(9, 'approve'), decide(2, 'reject', { item_key: keys[3] }), decide(3, 'reject'), decide(3, 'approve')]);
    expect(first.map((x) => [x.n, x.status, x.reason?.slice(0, 20)])).toEqual([
      [9, 'refused', 'digest cd-20261110T1'], [2, 'refused', 'item_key does not ma'], [3, 'rejected', 'left in Drafts untou'], [3, 'refused', 'the same number appe'],
    ]);
    expect(await run([decide(3, 'approve')])).toEqual([expect.objectContaining({ status: 'refused', reason: expect.stringMatching(/already decided/) })]);

    // "approve 2" from the old digest cannot land on the new digest's #2, nor on the old one.
    const oldKey2 = keys[2];
    await build('2026-11-10T18:00:00.000Z');
    expect(await run([decide(2, 'approve', { item_key: oldKey2 })])).toEqual([expect.objectContaining({ status: 'refused', reason: expect.stringMatching(/superseded by cd-20261110T1800Z/) })]);
    expect(await run([decide(2, 'approve', { item_key: 'o-0123456789abcdef01234567' })], 'cd-20261110T1800Z'))
      .toEqual([expect.objectContaining({ status: 'refused', reason: expect.stringMatching(/item_key does not match/) })]);
    expect(g.sent).toEqual([]);
  });

  it('approve on an Outlook draft sends it only when the draft is unchanged since the digest', async () => {
    const box = g.drafts.get(ROB)!;
    box[0] = { ...box[0], changeKey: 'CQAAABYAAAD4', subject: 'Re: SO32P reorder — 6000 yards' };
    expect(await run([decide(2, 'approve')])).toEqual([expect.objectContaining({ n: 2, status: 'refused', reason: expect.stringMatching(/changed since the digest/) })]);
    expect(g.sent).toEqual([]);
    expect(await run([decide(3, 'approve')])).toEqual([expect.objectContaining({ n: 3, status: 'sent' })]);
    expect(g.sent).toEqual(['AAMkAD-draft-gina-pr']);
  });

  it('a /send with no answer is failed with "may have gone out"; at most 10 Outlook sends per Chicago day', async () => {
    const hang = createChiefDecisionHandler({
      db, env: ENV, now: () => NOW, token: g.token,
      graphFetch: async (url, init) => { if (url.endsWith('/send')) throw new DOMException('timed out', 'TimeoutError'); return g.graphFetch(url, init); },
      relay: async () => ({ ok: false, message: 'unused' }),
    });
    expect(await hang(CHIEF_APPROVALS_AGENT, post([decide(3, 'approve')])).done)
      .toEqual([expect.objectContaining({ status: 'failed', reason: expect.stringMatching(/may have gone out; check Sent Items before resending/) })]);

    // Ten attempts already today (the one above plus nine more), so the next is refused before any send.
    for (let i = 0; i < 9; i++) {
      db.prepare(`INSERT INTO chief_digest_items (digest_id, n, item_key, source, subject, send_attempted_at) VALUES (?, ?, ?, 'outlook_draft', 's', ?)`)
        .run(DIGEST, 100 + i, `o-${i}`, '2026-11-10T06:30:00.000Z');
    }
    expect(await run([decide(2, 'approve')])).toEqual([expect.objectContaining({ status: 'refused', reason: expect.stringMatching(/daily cap reached: 10/) })]);
    expect(g.sent).toEqual([]);
    // 05:30Z is 11:30 PM the day before in Chicago: it does not count toward today.
    db.prepare("UPDATE chief_digest_items SET send_attempted_at = '2026-11-10T05:30:00.000Z' WHERE n = 100").run();
    await build('2026-11-10T18:00:00.000Z');
    expect(await run([decide(2, 'approve')], 'cd-20261110T1800Z')).toEqual([expect.objectContaining({ status: 'sent' })]);
  });

  it('reject never touches an Outlook draft, and the next digest marks it rejected', async () => {
    const r = await run([decide(2, 'reject'), decide(3, 'edit', { edit_text: 'say Tuesday' })]);
    expect(r.map((x) => x.status)).toEqual(['rejected', 'edit_noted']);
    expect(g.writes).toEqual([]);
    expect(g.drafts.get(ROB)!.map((d) => d.id)).toContain('AAMkAD-draft-cone');
    const next = await build('2026-11-10T18:00:00.000Z');
    const cone = (next.args.drafts as any[]).find((d) => d.subject.startsWith('Re: SO32P'));
    expect(cone.previously_rejected_at).toBe('2026-11-10T13:04:00Z');
  });

  it('edit on a proposal: key=value is applied and the card stays pending without arming Telegram; free text is only noted', async () => {
    expect(await run([decide(1, 'edit', { edit_text: 'text=Make it 400 yards of linen.' })])).toEqual([expect.objectContaining({ status: 'edit_applied' })]);
    const p = getProposalById(db, pid)!;
    expect(p).toMatchObject({ status: 'pending', edit_requested_at: null });
    expect(JSON.parse(p.action_payload).body.text).toBe('Make it 400 yards of linen.');
    expect(executed).toEqual([]);
    const next = await build('2026-11-10T18:00:00.000Z');
    expect((next.args.drafts as any[])[0]).toMatchObject({ proposal_id: pid, body: 'Make it 400 yards of linen.' });

    expect(await run([decide(1, 'edit', { edit_text: 'make it friendlier' })], 'cd-20261110T1800Z'))
      .toEqual([expect.objectContaining({ status: 'edit_noted' })]);
    expect(getProposalById(db, pid)).toMatchObject({ status: 'pending', edit_requested_at: null });
    expect(JSON.parse(getProposalById(db, pid)!.action_payload).body.text).toBe('Make it 400 yards of linen.');
    expect(replies).toHaveLength(1);
  });
});

describe('inbox_sweep_log key_facts migration', () => {
  it('adds the column to an existing table and keeps its rows', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE inbox_sweep_log (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL UNIQUE, mailbox TEXT NOT NULL,
      received_at TEXT NOT NULL, sender TEXT, subject TEXT, lane TEXT NOT NULL, folder TEXT, bot TEXT, unsubscribed INTEGER NOT NULL DEFAULT 0,
      mode TEXT NOT NULL, note TEXT, at TEXT NOT NULL);
      INSERT INTO inbox_sweep_log (message_id, mailbox, received_at, lane, mode, at) VALUES ('old-1', 'rob@dearborndenim.com', '2026-11-08T00:00:00Z', 'keep', 'live', '2026-11-08T00:00:00Z');`);
    initializeInboxSweepSchema(db);
    initializeInboxSweepSchema(db);
    expect(db.prepare('SELECT message_id, lane, key_facts FROM inbox_sweep_log').all()).toEqual([{ message_id: 'old-1', lane: 'keep', key_facts: null }]);
    db.close();
  });
});
