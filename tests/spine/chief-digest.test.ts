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

  const deps = (g: ReturnType<typeof fakeGraph>, at = '2026-11-10T18:00:00.000Z'): DigestDeps => ({
    db, env: ENV, now: () => new Date(at), graphFetch: g.graphFetch, token: g.token,
  });

  it('numbers email proposals then Outlook drafts, skips drafts with no recipient and posts one task to Chief', async () => {
    const pid = seedEmailProposal(db);
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
    expect(drafts[0]).toMatchObject({ proposal_id: pid, drafted_by: 'sourcing', to: ['sales@carr.example'] });
    expect(drafts[1]).toMatchObject({ drafted_by: 'Outlook draft', to: ['owen@conedenim.com'], cc: [GINA], previously_rejected_at: null });
    expect(drafts[1].body_preview.length).toBeLessThanOrEqual(300);
    expect(drafts[1].body_preview).toMatch(/^Hi Owen, Please confirm 600 yards/);
    expect(drafts[2].body_preview).toBe('Hi Jen, Thanks for reaching out & Robert would be glad to host you.');
    expect(payload.args.outlook_more_not_shown).toEqual([GINA]);
    expect(sweep).toMatchObject({
      folders: { Promotions: 1, archive: 1 }, unsubscribed: ['news@shop.example'], handoffs: { 'Purchasing Bot': 1 },
      left_in_inbox: [{ mailbox: MMI, sender: 'cfo@partner.example', subject: 'Term sheet', lane: 'keep', key_facts: 'Wants a signed term sheet by Friday.' }],
    });
    expect(sweep.errors).toEqual([{ mailbox: ROB, sender: 'x@y.example', subject: 'Odd', note: 'classifier: refusal' }]);
    const items = db.prepare('SELECT n, source, mailbox, message_id, change_key FROM chief_digest_items ORDER BY n').all();
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
    expect(empty.args.since).toBe('2026-11-10T18:00:00.000Z');
  });
});

describe('chief_draft_decision', () => {
  let db: Database.Database;
  let g: ReturnType<typeof fakeGraph>;
  let pid: number;
  let executed: number[];
  let replies: string[];
  beforeEach(async () => {
    db = new Database(':memory:');
    initializeSchema(db);
    pid = seedEmailProposal(db);
    g = fakeGraph();
    executed = [];
    replies = [];
    await buildChiefDigest({ db, env: ENV, now: () => new Date('2026-11-10T13:00:00.000Z'), graphFetch: g.graphFetch, token: g.token });
  });
  afterEach(() => db.close());

  const cardDeps: () => CardDeps = () => ({
    now: () => '2026-11-10T13:05:00.000Z',
    execute: async (id) => { executed.push(id); recordExecution(db, id, 'executed', { http_status: 200 }); return { ok: true, http_status: 200, body: {} }; },
    reply: async (t) => { replies.push(t); },
  });
  const handler = (env: Record<string, string> = ENV) => createChiefDecisionHandler({
    db, env, now: () => '2026-11-10T13:05:00.000Z', graphFetch: g.graphFetch, token: g.token,
    relay: (id, decision, editText) => relayProposalDecision(db, id, decision, DECIDED_BY, cardDeps(), editText ?? undefined),
  } satisfies DecisionDeps);
  const post = (payload: Record<string, unknown>) => ({ source_hand: CHIEF_APPROVALS_AGENT, brand_id: 'dearborn-denim', event_type: 'chief_draft_decision', urgent: false, payload });
  const decide = (n: number, decision: string, extra: Record<string, unknown> = {}) => ({ n, decision, robert_quote: `${decision} ${n}`, decided_at: '2026-11-10T13:04:00Z', ...extra });
  const answers = () => (db.prepare("SELECT payload FROM spine_events WHERE event_type = 'grok_task_chief' ORDER BY id").all() as { payload: string }[])
    .map((r) => JSON.parse(r.payload)).filter((p) => p.kind === 'chief_draft_decision_result');

  it('refuses every key but grok-chief-approvals, and everything while the digest is off', async () => {
    const body = post({ digest_id: 'cd-20261110T1300Z', decisions: [decide(1, 'approve')] });
    expect(handler()('grok-bots', body).status).toBe(403);
    expect(handler({ ...ENV, CHIEF_DIGEST_MODE: 'off' })(CHIEF_APPROVALS_AGENT, body).status).toBe(503);
    expect(handler()(CHIEF_APPROVALS_AGENT, post({ digest_id: 'cd-20261110T1300Z', decisions: [{ n: 1, decision: 'approve', decided_at: '2026-11-10T13:04:00Z' }] })).status).toBe(400);
    expect(handler()(CHIEF_APPROVALS_AGENT, post({ digest_id: 'cd-20261110T1300Z', decisions: [decide(1, 'edit')] })).status).toBe(400);
    expect(getProposalById(db, pid)!.status).toBe('pending');
    expect(g.sent).toEqual([]);
  });

  it('approve on a proposal runs the Telegram card path: decided by robert via chief, trust counted, card chat told', async () => {
    const r = handler()(CHIEF_APPROVALS_AGENT, post({ digest_id: 'cd-20261110T1300Z', decisions: [decide(1, 'approve')] }));
    expect(r.status).toBe(200);
    expect(await r.done).toEqual([expect.objectContaining({ n: 1, status: 'sent', proposal_id: pid })]);
    expect(executed).toEqual([pid]);
    expect(getProposalById(db, pid)).toMatchObject({ status: 'executed', decided_by: 'robert via chief' });
    expect(getTrustRow(db, { agent: 'sourcing', brand_id: 'dearborn-denim', action_type: 'rfq_send' })!.approved_as_proposed).toBe(1);
    expect(replies[0]).toMatch(new RegExp(`^Approved #${pid}`));
    expect(answers()[0]).toMatchObject({ task_id: expect.stringMatching(/^chief-decision-/), args: { digest_id: 'cd-20261110T1300Z', message: '1 sent.' } });
  });

  it('first decider wins: a card already approved on Telegram is refused and not executed again', async () => {
    decideProposal(db, pid, 'approved', 'robert-mcmillan', '2026-11-10T13:01:00.000Z');
    const r = handler()(CHIEF_APPROVALS_AGENT, post({ digest_id: 'cd-20261110T1300Z', decisions: [decide(1, 'approve')] }));
    expect(await r.done).toEqual([expect.objectContaining({ n: 1, status: 'refused', reason: expect.stringMatching(/already approved/) })]);
    expect(executed).toEqual([]);
  });

  it('refuses an unknown number, a repeat of a decided number and a superseded digest', async () => {
    const h = handler();
    const first = h(CHIEF_APPROVALS_AGENT, post({ digest_id: 'cd-20261110T1300Z', decisions: [decide(9, 'approve'), decide(3, 'reject'), decide(3, 'approve')] }));
    expect((await first.done)!.map((x) => [x.n, x.status])).toEqual([[9, 'refused'], [3, 'rejected'], [3, 'refused']]);
    const again = h(CHIEF_APPROVALS_AGENT, post({ digest_id: 'cd-20261110T1300Z', decisions: [decide(3, 'approve')] }));
    expect(await again.done).toEqual([expect.objectContaining({ status: 'refused', reason: expect.stringMatching(/already decided/) })]);

    await buildChiefDigest({ db, env: ENV, now: () => new Date('2026-11-10T18:00:00.000Z'), graphFetch: g.graphFetch, token: g.token });
    const stale = h(CHIEF_APPROVALS_AGENT, post({ digest_id: 'cd-20261110T1300Z', decisions: [decide(2, 'approve')] }));
    expect(await stale.done).toEqual([expect.objectContaining({ status: 'refused', reason: expect.stringMatching(/superseded by cd-20261110T1800Z/) })]);
    expect(g.sent).toEqual([]);
  });

  it('approve on an Outlook draft sends it only when the draft is unchanged since the digest', async () => {
    const box = g.drafts.get(ROB)!;
    box[0] = { ...box[0], changeKey: 'CQAAABYAAAD4', subject: 'Re: SO32P reorder — 6000 yards' };
    const h = handler();
    const changed = h(CHIEF_APPROVALS_AGENT, post({ digest_id: 'cd-20261110T1300Z', decisions: [decide(2, 'approve')] }));
    expect(await changed.done).toEqual([expect.objectContaining({ n: 2, status: 'refused', reason: expect.stringMatching(/changed since the digest/) })]);
    expect(g.sent).toEqual([]);

    const ok = h(CHIEF_APPROVALS_AGENT, post({ digest_id: 'cd-20261110T1300Z', decisions: [decide(3, 'approve')] }));
    expect(await ok.done).toEqual([expect.objectContaining({ n: 3, status: 'sent' })]);
    expect(g.sent).toEqual(['AAMkAD-draft-gina-pr']);
  });

  it('reject never touches an Outlook draft, and the next digest marks it rejected', async () => {
    const r = handler()(CHIEF_APPROVALS_AGENT, post({ digest_id: 'cd-20261110T1300Z', decisions: [decide(2, 'reject'), decide(3, 'edit', { edit_text: 'say Tuesday' })] }));
    expect((await r.done)!.map((x) => x.status)).toEqual(['rejected', 'edit_noted']);
    expect(g.writes).toEqual([]);
    expect(g.drafts.get(ROB)!.map((d) => d.id)).toContain('AAMkAD-draft-cone');
    const next = await buildChiefDigest({ db, env: ENV, now: () => new Date('2026-11-10T18:00:00.000Z'), graphFetch: g.graphFetch, token: g.token });
    const cone = (next.args.drafts as any[]).find((d) => d.subject.startsWith('Re: SO32P'));
    expect(cone.previously_rejected_at).toBe('2026-11-10T13:04:00Z');
  });

  it('edit on a proposal opens the card edit and sends nothing', async () => {
    const r = handler()(CHIEF_APPROVALS_AGENT, post({ digest_id: 'cd-20261110T1300Z', decisions: [decide(1, 'edit', { edit_text: 'text=Make it 400 yards' })] }));
    expect(await r.done).toEqual([expect.objectContaining({ status: 'edit_requested' })]);
    expect(executed).toEqual([]);
    expect(getProposalById(db, pid)).toMatchObject({ status: 'pending', edit_requested_at: '2026-11-10T13:05:00.000Z' });
    expect(replies[0]).toMatch(/Edit for #\d+ relayed .*Nothing has been sent/);
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
