import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  buildInboxReport, messageFromGraph, parseReportItems, reportSlot, withholdNumbers,
} from '../../src/email/inbox-report.js';

const graphMsg = {
  from: { emailAddress: { address: 'Buyer@Hospital.org', name: 'Pat Buyer' } },
  subject: 'Scrub order quote', bodyPreview: 'Can you   quote 500 scrubs by Friday?', receivedDateTime: '2026-11-13T15:00:00Z', isRead: false,
};

describe('inbox report boundary', () => {
  it('maps a Graph message', () => {
    expect(messageFromGraph(graphMsg, 'rob@dearborndenim.com')).toEqual({
      mailbox: 'rob@dearborndenim.com', from: 'buyer@hospital.org', from_name: 'Pat Buyer', subject: 'Scrub order quote',
      preview: 'Can you quote 500 scrubs by Friday?', received_at: '2026-11-13T15:00:00Z', is_read: false,
    });
  });

  it('parses model items, drops bad indexes, keeps omitted mail as FYI', () => {
    const items = parseReportItems(JSON.stringify({ items: [
      { index: 1, section: 'reply_owed', category: 'hospital', line: 'Wants a quote' },
      { index: 7, section: 'action', category: 'other', line: 'out of range' },
    ] }), 2);
    expect(items.map((i) => [i.index, i.section])).toEqual([[0, 'fyi'], [1, 'reply_owed']]);
  });

  it('withholds card, account and SSN numbers but keeps short numbers', () => {
    expect(withholdNumbers('card 4111 1111 1111 1111, ssn 123-45-6789, acct 123456789, PO 1014 for 500')).toBe(
      'card [number withheld], ssn [number withheld], acct [number withheld], PO 1014 for 500');
  });

  it('slots by Chicago hour', () => {
    expect(reportSlot(new Date('2026-11-13T13:00:00Z'))).toBe('morning');
    expect(reportSlot(new Date('2026-11-13T18:00:00Z'))).toBe('noon');
    expect(reportSlot(new Date('2026-11-13T23:00:00Z'))).toBe('evening');
  });

  it('posts one notify task per slot, says when a mailbox cannot be read, and never repeats a slot', async () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE spine_events (id INTEGER PRIMARY KEY, source_hand TEXT, brand_id TEXT, event_type TEXT, payload TEXT, urgent INTEGER, received_at TEXT, posted_by TEXT);
      CREATE TABLE inbox_sweep_log (mailbox TEXT, sender TEXT, subject TEXT, lane TEXT, folder TEXT, mode TEXT, at TEXT);
      INSERT INTO inbox_sweep_log VALUES ('rob@dearborndenim.com', 'deals@shop.com', 'Sale', 'promotions', 'Promotions', 'live', '2026-11-13T20:00:00Z');`);
    const deps = {
      db, mailboxes: ['rob@dearborndenim.com', 'robert@mcmillan-manufacturing.com'], now: () => new Date('2026-11-13T23:00:00Z'),
      token: async () => 't',
      graphFetch: async (url: string) => (url.includes('mcmillan-manufacturing')
        ? new Response('no', { status: 503 })
        : new Response(JSON.stringify({ value: [graphMsg] }), { status: 200 })),
      classify: async () => [{ index: 0, section: 'reply_owed' as const, category: 'hospital', line: 'Wants a quote for 500 scrubs by Friday' }],
    };
    const built = await buildInboxReport(deps);
    expect(built.text).toContain('Inbox report evening 2026-11-13');
    expect(built.text).toContain('COULD NOT READ: robert@mcmillan-manufacturing.com (HTTP 503)');
    expect(built.text).toMatch(/2\) REPLIES ROB OWES: 1\n- \[hospital\] Pat Buyer/);
    expect(built.text).toContain('deals@shop.com (DD): Sale -> Promotions');
    const ev = db.prepare('SELECT event_type, payload FROM spine_events').all() as Array<{ event_type: string; payload: string }>;
    expect(ev).toHaveLength(1);
    const p = JSON.parse(ev[0]!.payload);
    expect([ev[0]!.event_type, p.kind, p.args.audience, p.args.title]).toEqual(['grok_task_chief', 'notify', 'for_rob', 'Inbox report evening 2026-11-13']);
    expect((await buildInboxReport(deps)).event_id).toBeNull();
  });
});
