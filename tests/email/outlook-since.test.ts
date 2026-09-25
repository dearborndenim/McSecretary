import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../src/auth/graph.js', () => ({
  getGraphToken: async () => 'test-token',
}));

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
