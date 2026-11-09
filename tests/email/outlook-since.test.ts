import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../src/auth/graph.js', () => ({
  getGraphToken: async () => 'test-token',
}));

import { readFileSync } from 'node:fs';
import { toGraphDateTime, fetchUnreadOutlookEmails } from '../../src/email/outlook.js';

describe('toGraphDateTime', () => {
  it('converts a SQLite datetime(\'now\') value (UTC, space-separated, no offset) to ISO 8601', () => {
    expect(toGraphDateTime('2026-09-24 09:01:18')).toBe('2026-09-24T09:01:18.000Z');
  });

  it('leaves an ISO input with a Z suffix unchanged in value', () => {
    expect(toGraphDateTime('2026-09-24T09:01:18.000Z')).toBe('2026-09-24T09:01:18.000Z');
  });

  it('converts an ISO input with a numeric offset to the equivalent UTC instant', () => {
    // 2026-09-24T09:01:18-05:00 === 2026-09-24T14:01:18Z
    expect(toGraphDateTime('2026-09-24T09:01:18-05:00')).toBe('2026-09-24T14:01:18.000Z');
  });

  it('throws a descriptive error for a value that does not parse as a date', () => {
    expect(() => toGraphDateTime('not-a-date')).toThrow(/not-a-date/);
  });
});

describe('fetchUnreadOutlookEmails', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ value: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('puts the normalised ISO value into the $filter of the request URL', async () => {
    await fetchUnreadOutlookEmails('rob@dearborndenim.com', '2026-09-24 09:01:18');

    const url = fetchMock.mock.calls[0]![0] as string;
    const filter = new URL(url).searchParams.get('$filter')!;
    expect(filter).toContain('receivedDateTime ge 2026-09-24T09:01:18.000Z');
  });
});

describe('fetchUnreadOutlookEmails leaves sweep-filed mail alone', () => {
  const folders = JSON.parse(readFileSync(new URL('../fixtures/inbox-sweep/mail-folders.json', import.meta.url), 'utf8'));
  const msg = (id: string, parentFolderId: string) => ({
    id, parentFolderId, subject: id, bodyPreview: '', body: { content: '', contentType: 'text' },
    receivedDateTime: '2026-11-09T10:00:00Z', conversationId: 'c', isRead: false,
    from: { emailAddress: { address: 'a@b.example', name: 'A' } },
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('drops unread mail in Promotions, DMARC Reports, Archive and Junk Email; keeps Inbox and other folders', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const body = url.includes('/mailFolders?')
        ? folders
        : { value: [
            msg('in-inbox', 'AAMkAD-fld-inbox'),
            msg('in-promo', 'AAMkAD-fld-promo'),
            msg('in-dmarc', 'AAMkAD-fld-dmarc'),
            msg('in-archive', 'AAMkAD-fld-archive'),
            msg('in-junk', 'AAMkAD-fld-junk'),
            msg('in-custom', 'AAMkAD-fld-custom'),
          ] };
      return new Response(JSON.stringify(body), { status: 200 });
    }));
    const out = await fetchUnreadOutlookEmails('rob@dearborndenim.com', null);
    expect(out.map((e) => e.id)).toEqual(['in-inbox', 'in-custom']);
  });

  it('excludes nothing when the folder lookup fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.includes('/mailFolders?')
      ? new Response('denied', { status: 403 })
      : new Response(JSON.stringify({ value: [msg('in-promo', 'AAMkAD-fld-promo')] }), { status: 200 }))));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = await fetchUnreadOutlookEmails('rob@dearborndenim.com', null);
    expect(out.map((e) => e.id)).toEqual(['in-promo']);
  });
});
