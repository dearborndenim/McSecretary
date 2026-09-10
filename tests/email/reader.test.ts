import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../src/auth/graph.js', () => ({
  getGraphToken: async () => 'test-token',
}));

import { fetchRecentEmails, toRawEmail, type EmailSummary } from '../../src/email/reader.js';

function graphResponse(value: unknown[]): Response {
  return new Response(JSON.stringify({ value }), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('fetchRecentEmails', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => graphResponse([
      {
        id: 'm1',
        from: { emailAddress: { address: 'sales@carr.example', name: 'Carr Textiles' } },
        subject: 'RE: fabric',
        bodyPreview: 'Here are three linens',
        body: { content: '<p>Style CT-4410, $6.75/yd</p>', contentType: 'html' },
        receivedDateTime: '2026-09-12T08:00:00.000Z',
        isRead: false,
        categories: [],
        conversationId: 'thread-1',
      },
    ]));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('by default omits body/threadId and does not request the body field (existing spam-scan behavior)', async () => {
    const result = await fetchRecentEmails('rob@dearborndenim.com', 4, 30);
    expect(result).toEqual([{
      id: 'm1', account: 'rob@dearborndenim.com', from: 'sales@carr.example', fromName: 'Carr Textiles',
      subject: 'RE: fabric', bodyPreview: 'Here are three linens', receivedAt: '2026-09-12T08:00:00.000Z',
      isRead: false, categories: [],
    }]);
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).not.toContain(',body,');
    expect(url).not.toContain('conversationId');
  });

  it('with includeBody: true, requests and returns a stripped body plus threadId', async () => {
    const result = await fetchRecentEmails('rob@dearborndenim.com', 4, 30, true);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'm1',
      body: 'Style CT-4410, $6.75/yd',
      threadId: 'thread-1',
    });
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain(',body,');
    expect(url).toContain('conversationId');
  });

  it('throws on a Graph API error so a bad token does not look like "no emails"', async () => {
    fetchMock.mockImplementationOnce(async () => new Response('unauthorized', { status: 401 }));
    await expect(fetchRecentEmails('rob@dearborndenim.com')).rejects.toThrow(/Graph API error \(401\)/);
  });
});

describe('toRawEmail', () => {
  const base: EmailSummary = {
    id: 'm1', account: 'rob@dearborndenim.com', from: 'sales@carr.example', fromName: 'Carr Textiles',
    subject: 'RE: fabric', bodyPreview: 'preview', receivedAt: '2026-09-12T08:00:00.000Z',
    isRead: false, categories: [],
  };

  it('maps an EmailSummary fetched with includeBody into the RawEmail shape the RFQ intake expects', () => {
    const raw = toRawEmail({ ...base, body: 'full body text', threadId: 'thread-1' });
    expect(raw).toEqual({
      id: 'm1', account: 'rob@dearborndenim.com', sender: 'sales@carr.example', senderName: 'Carr Textiles',
      subject: 'RE: fabric', bodyPreview: 'preview', body: 'full body text',
      receivedAt: '2026-09-12T08:00:00.000Z', threadId: 'thread-1', isRead: false,
    });
  });

  it('falls back to bodyPreview and an empty threadId when fetched without includeBody', () => {
    const raw = toRawEmail(base);
    expect(raw.body).toBe('preview');
    expect(raw.threadId).toBe('');
  });
});
