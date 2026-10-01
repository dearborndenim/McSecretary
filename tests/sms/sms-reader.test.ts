import { describe, it, expect, vi, beforeEach } from 'vitest';

// We test the exported functions from sms-reader
// Since sms-reader calls main() at import time, we need to mock the DB and test individual functions

describe('SMS Reader — sendToRailway', () => {
  const mockMessages = [
    {
      rowid: 1,
      text: 'Hello from test',
      isFromMe: false,
      sender: '+15551234567',
      service: 'iMessage',
      groupName: null,
      date: '2026-04-14 10:00:00',
    },
    {
      rowid: 2,
      text: 'Reply from Rob',
      isFromMe: true,
      sender: '+15551234567',
      service: 'iMessage',
      groupName: null,
      date: '2026-04-14 10:01:00',
    },
  ];

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('throws when API_SECRET is missing but URL is set', async () => {
    const { sendToRailway } = await import('../../mac-agent/sms-reader.js');

    await expect(
      sendToRailway(mockMessages, 'https://example.com', '')
    ).rejects.toThrow('MCSECRETARY_API_SECRET is not set');
  });

  it('retries on network failure and eventually throws', async () => {
    const { sendToRailway } = await import('../../mac-agent/sms-reader.js');

    // Mock global fetch to always fail
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = vi.fn(async () => {
      fetchCalls++;
      throw new Error('Network unreachable');
    }) as typeof fetch;

    try {
      await expect(
        sendToRailway(mockMessages, 'https://example.com', 'test-secret')
      ).rejects.toThrow('Network unreachable');

      // Should have retried 3 times
      expect(fetchCalls).toBe(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }, 60000); // longer timeout for retries

  it('succeeds on second attempt after initial failure', async () => {
    const { sendToRailway } = await import('../../mac-agent/sms-reader.js');

    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = vi.fn(async () => {
      fetchCalls++;
      if (fetchCalls === 1) {
        throw new Error('Temporary failure');
      }
      return new Response('OK', { status: 200 });
    }) as typeof fetch;

    try {
      await sendToRailway(mockMessages, 'https://example.com', 'test-secret');
      expect(fetchCalls).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }, 30000);

  it('throws on non-OK response after retries', async () => {
    const { sendToRailway } = await import('../../mac-agent/sms-reader.js');

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      return new Response('Forbidden', { status: 403 });
    }) as typeof fetch;

    try {
      await expect(
        sendToRailway(mockMessages, 'https://example.com', 'test-secret')
      ).rejects.toThrow('Railway API error (403)');
    } finally {
      globalThis.fetch = originalFetch;
    }
  }, 60000);

  it('sends correct payload format', async () => {
    const { sendToRailway } = await import('../../mac-agent/sms-reader.js');

    const originalFetch = globalThis.fetch;
    let capturedBody: string | null = null;
    let capturedHeaders: Record<string, string> = {};

    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      capturedBody = init?.body as string;
      const headers = init?.headers as Record<string, string>;
      capturedHeaders = headers;
      return new Response('OK', { status: 200 });
    }) as typeof fetch;

    try {
      await sendToRailway(mockMessages, 'https://example.com', 'my-secret');

      expect(capturedHeaders['Content-Type']).toBe('application/json');
      expect(capturedHeaders['Authorization']).toBe('Bearer my-secret');

      const body = JSON.parse(capturedBody!);
      expect(body.messages).toHaveLength(2);
      expect(body.messages[0].text).toBe('Hello from test');
      expect(body.messages[1].isFromMe).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
