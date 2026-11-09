import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import { getSweepWatermark } from '../../src/db/inbox-sweep-schema.js';
import {
  parseSweepClassifications,
  runInboxSweep,
  type InboxSweepDeps,
} from '../../src/email/inbox-sweep.js';
import { COMPANY_DOMAINS, type SweepClassification, type SweepMessage } from '../../src/email/inbox-sweep-rules.js';

const ROB = 'rob@dearborndenim.com';
const FIXTURES = ['dmarc-report', 'gina-vendor-reply', 'promo-one-click', 'promo-mailto-only', 'bank-alert', 'phish-fake-invoice', 'dla-rfq'];
const raw = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/inbox-sweep/${name}.json`, import.meta.url), 'utf8'));
const folders = raw('mail-folders');

describe('parseSweepClassifications', () => {
  const row = { index: 1, lane: 'promotions', bot: 'none', key_facts: 'sale', urgent_today: false, confidence: 1.4 };

  it('maps a valid batch, clamping confidence and dropping out-of-range or repeated indexes', () => {
    const out = parseSweepClassifications(JSON.stringify({ results: [row, { ...row, index: 1, lane: 'junk' }, { ...row, index: 3 }] }), 2);
    expect(out).toEqual([{ index: 1, lane: 'promotions', bot: 'none', key_facts: 'sale', urgent_today: false, confidence: 1 }]);
  });

  it('throws on an unknown lane or bot, so nothing in the batch is acted on', () => {
    expect(() => parseSweepClassifications(JSON.stringify({ results: [{ ...row, lane: 'delete' }] }), 1)).toThrow(/lane/);
    expect(() => parseSweepClassifications(JSON.stringify({ results: [{ ...row, bot: 'Chief' }] }), 1)).toThrow(/bot/);
    expect(() => parseSweepClassifications('{"classifications":[]}', 1)).toThrow(/results/);
  });
});

interface Recorded { method: string; url: string; body?: string; headers: Record<string, string>; redirect?: string }

/** Answers the classifier would give each fixture, keyed by subject. */
function stubClassifier(messages: SweepMessage[]): Promise<SweepClassification[]> {
  return Promise.resolve(messages.map((m, i) => {
    const c = { index: i + 1, bot: 'none', key_facts: m.subject, urgent_today: false, confidence: 0.95 } as const;
    if (/Fall Sale|specials/.test(m.subject)) return { ...c, lane: 'promotions' };
    if (/Fraud alert/.test(m.subject)) return { ...c, lane: 'keep', urgent_today: true };
    if (/Overdue invoice/.test(m.subject)) return { ...c, lane: 'phishing' };
    if (/RFQ SPE1C1/.test(m.subject)) return { ...c, lane: 'gov_bid', bot: 'General Paton Bot' };
    if (/Selvedge/.test(m.subject)) return { ...c, lane: 'handoff', bot: 'Sourcing Bot' };
    return { ...c, lane: 'keep' };
  }));
}

function harness(mode: InboxSweepDeps['mode']) {
  const graph: Recorded[] = [];
  const unsub: Recorded[] = [];
  const inbox = FIXTURES.map(raw);
  const record = (list: Recorded[], url: string, init?: RequestInit): Recorded => {
    const r = {
      method: init?.method ?? 'GET',
      url,
      body: typeof init?.body === 'string' ? init.body : undefined,
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])),
      redirect: init?.redirect,
    };
    list.push(r);
    return r;
  };
  const graphFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const r = record(graph, url, init);
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
    if (r.method === 'GET' && url.includes('/mailFolders/inbox/messages')) return json({ value: inbox });
    if (r.method === 'GET' && /\/mailFolders\?/.test(url)) return json(folders);
    if (r.method === 'GET' && url.includes('/mailFolders/AAMkAD-fld-mmi/messages')) return json({ value: [] });
    if (r.method === 'GET' && (url.includes('/sentitems/messages') || url.includes('/messages?$filter='))) return json({ value: [] });
    if (r.method === 'POST' && url.endsWith('/mailFolders')) return json({ id: 'AAMkAD-fld-gov', displayName: 'Gov Bids' }, 201);
    if (r.method === 'POST' && url.endsWith('/move')) return json({ id: `moved-${url}` }, 201);
    return json({ error: { code: 'NotStubbed' } }, 404);
  }) as typeof fetch;
  const unsubscribeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    record(unsub, String(input), init);
    return new Response('', { status: 200 });
  }) as typeof fetch;

  const db = new Database(':memory:');
  initializeSchema(db);
  const deps: InboxSweepDeps = {
    db,
    mode,
    mailboxes: [ROB],
    now: () => new Date('2026-11-09T14:15:00.000Z'),
    graphFetch,
    token: async () => 'graph-token',
    unsubscribeFetch,
    classify: stubClassifier,
    isRfqReply: () => false,
    companyDomains: COMPANY_DOMAINS,
    deniedAddresses: new Set([ROB]),
    engagementMailboxes: ['gina@dearborndenim.com'],
    mmiSenderCache: new Map(),
  };
  return { db, deps, graph, unsub };
}

function logRows(db: Database.Database) {
  return db.prepare('SELECT message_id, lane, folder, bot, unsubscribed, mode, note FROM inbox_sweep_log ORDER BY id').all() as {
    message_id: string; lane: string; folder: string | null; bot: string | null; unsubscribed: number; mode: string; note: string | null;
  }[];
}

const eventCount = (db: Database.Database) => (db.prepare('SELECT COUNT(*) AS n FROM spine_events').get() as { n: number }).n;

describe('runInboxSweep', () => {
  it('off: makes no request and writes nothing', async () => {
    const h = harness('off');
    const out = await runInboxSweep(h.deps);
    expect(h.graph).toEqual([]);
    expect(h.unsub).toEqual([]);
    expect(logRows(h.db)).toEqual([]);
    expect(out.eventId).toBeNull();
  });

  it('shadow: only reads mail, logs the decisions, moves nothing, unsubscribes nothing, posts nothing', async () => {
    const h = harness('shadow');
    await runInboxSweep(h.deps);
    expect(h.graph.length).toBeGreaterThan(0);
    expect(h.graph.every((r) => r.method === 'GET')).toBe(true);
    expect(h.unsub).toEqual([]);
    expect(eventCount(h.db)).toBe(0);
    const rows = logRows(h.db);
    expect(rows).toHaveLength(7);
    expect(rows.every((r) => r.mode === 'shadow' && r.unsubscribed === 0)).toBe(true);
    expect(rows.find((r) => r.message_id === 'AAMkAD-promo-1')).toMatchObject({ folder: 'Promotions', note: 'would unsubscribe (one-click)' });
    expect(getSweepWatermark(h.db, ROB)).toBe('2026-11-09T14:09:00Z');
  });

  it('live: moves and unsubscribes within the hard limits and tells Chief once', async () => {
    const h = harness('live');
    const out = await runInboxSweep(h.deps);

    // Graph: reads, one folder create, moves. No delete, send, reply or forward.
    for (const r of h.graph) {
      const ok = r.method === 'GET'
        || (r.method === 'POST' && (r.url.endsWith('/mailFolders') || r.url.endsWith('/move')));
      expect(ok, `${r.method} ${r.url}`).toBe(true);
      expect(r.url).not.toMatch(/sendMail|\/reply|\/forward|createReply|createForward/i);
    }

    // One unsubscribe, the RFC 8058 POST to the https URI, without the Graph bearer or redirects.
    expect(h.unsub).toEqual([{
      method: 'POST',
      url: 'https://mail.bestmadeco.example/unsub/abc123?e=rob%40dearborndenim.com',
      body: 'List-Unsubscribe=One-Click',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      redirect: 'manual',
    }]);

    const byId = Object.fromEntries(logRows(h.db).map((r) => [r.message_id, r]));
    expect(byId['AAMkAD-dmarc-1']).toMatchObject({ lane: 'dmarc', folder: 'DMARC Reports' });
    expect(byId['AAMkAD-gina-1']).toMatchObject({ lane: 'gina_thread', folder: 'archive', bot: 'Sourcing Bot' });
    expect(byId['AAMkAD-promo-1']).toMatchObject({ folder: 'Promotions', unsubscribed: 1 });
    expect(byId['AAMkAD-promo-2']).toMatchObject({ folder: 'Promotions', unsubscribed: 0 });
    expect(byId['AAMkAD-bank-1']).toMatchObject({ folder: null, unsubscribed: 0 });
    expect(byId['AAMkAD-phish-1']).toMatchObject({ lane: 'phishing', folder: 'junkemail' });
    expect(byId['AAMkAD-dla-1']).toMatchObject({ lane: 'gov_bid', folder: 'Gov Bids', bot: 'General Paton Bot' });
    expect(h.graph.filter((r) => r.url.endsWith('/move'))).toHaveLength(6);

    const ev = h.db.prepare('SELECT event_type, source_hand, urgent, payload FROM spine_events').all() as
      { event_type: string; source_hand: string; urgent: number; payload: string }[];
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ event_type: 'grok_task_chief', source_hand: 'mcsecretary', urgent: 1 });
    const payload = JSON.parse(ev[0]!.payload);
    expect(payload).toMatchObject({ kind: 'inbox_sweep', filed_by: 'mcsecretary', notify: true });
    expect(payload.args.handoffs.map((x: { bot: string }) => x.bot).sort()).toEqual(['General Paton Bot', 'Sourcing Bot']);
    expect(payload.args.tell_robert.map((x: { reason: string }) => x.reason).sort()).toEqual(['gov_bid', 'phishing', 'urgent_today']);
    expect(out.eventId).toBe(1);
  });

  it('live: a second run over the same inbox acts on nothing twice', async () => {
    const h = harness('live');
    await runInboxSweep(h.deps);
    const moves = h.graph.filter((r) => r.url.endsWith('/move')).length;
    await runInboxSweep(h.deps);
    expect(h.graph.filter((r) => r.url.endsWith('/move')).length).toBe(moves);
    expect(h.unsub).toHaveLength(1);
    expect(eventCount(h.db)).toBe(1);
    expect(logRows(h.db)).toHaveLength(7);
  });

  it('a classifier failure moves and logs nothing and leaves the watermark for the retry', async () => {
    const h = harness('live');
    h.deps.classify = async () => { throw new Error('overloaded'); };
    const out = await runInboxSweep(h.deps);
    expect(out.mailboxes[0]!.errors).toEqual(['overloaded']);
    expect(h.graph.filter((r) => r.method === 'POST')).toEqual([]);
    expect(logRows(h.db)).toEqual([]);
    expect(getSweepWatermark(h.db, ROB)).toBeNull();
  });
});
