import { describe, it, expect, vi } from 'vitest';
import {
  buildInviteBody,
  sendInviteEmail,
  type SendInviteEmailDeps,
} from '../../src/email/invite-sender.js';

describe('buildInviteBody', () => {
  it('includes name, code, and bot handle', () => {
    const body = buildInviteBody('Olivier', 'abc12345', '@mcsecretary_bot');
    expect(body).toContain('Hi Olivier');
    expect(body).toContain('/start abc12345');
    expect(body).toContain('@mcsecretary_bot');
  });

  it('mentions the member schedule window 6 AM – 2:30 PM CT', () => {
    const body = buildInviteBody('Merab', 'code', '@bot');
    expect(body).toContain('6 AM');
    expect(body).toContain('2:30 PM');
    expect(body).toContain('CT');
  });

  it('mentions 7-day expiry', () => {
    const body = buildInviteBody('X', 'c', '@b');
    expect(body).toContain('7 days');
  });
});

describe('sendInviteEmail — stdout fallback', () => {
  it('logs to stdout and returns transport=stdout when INVITE_SENDER_EMAIL unset', async () => {
    const logs: string[] = [];
    const deps: SendInviteEmailDeps = {
      env: {},
      logger: (line) => logs.push(line),
    };

    const result = await sendInviteEmail(
      { to: 'olivier@dearborndenim.com', name: 'Olivier', code: 'abc12345' },
      deps,
    );

    expect(result.ok).toBe(true);
    expect(result.transport).toBe('stdout');
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain('olivier@dearborndenim.com');
    expect(logs[0]).toContain('abc12345');
    expect(logs[0]).toContain('/start abc12345');
  });

  it('falls back to stdout when SMTP_HOST is explicitly empty', async () => {
    const logs: string[] = [];
    const deps: SendInviteEmailDeps = {
      env: { SMTP_HOST: '', INVITE_SENDER_EMAIL: 'rob@dearborndenim.com' },
      logger: (line) => logs.push(line),
    };

    const result = await sendInviteEmail(
      { to: 'x@x.com', name: 'X', code: 'c' },
      deps,
    );

    expect(result.transport).toBe('stdout');
    expect(logs.length).toBe(1);
  });
});

describe('sendInviteEmail — Graph transport', () => {
  it('POSTs to the Graph sendMail endpoint with Bearer auth when configured', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(''),
    });
    const deps: SendInviteEmailDeps = {
      env: { INVITE_SENDER_EMAIL: 'rob@dearborndenim.com', SMTP_HOST: 'graph' },
      getGraphToken: async () => 'test-token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    };

    const result = await sendInviteEmail(
      { to: 'olivier@dearborndenim.com', name: 'Olivier', code: 'abc12345' },
      deps,
    );

    expect(result.ok).toBe(true);
    expect(result.transport).toBe('graph');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [calledUrl, calledOpts] = fetchImpl.mock.calls[0];
    expect(calledUrl).toContain('https://graph.microsoft.com/v1.0/users/');
    expect(calledUrl).toContain('rob%40dearborndenim.com');
    expect(calledUrl).toContain('/sendMail');
    expect(calledOpts.method).toBe('POST');
    expect((calledOpts.headers as Record<string, string>).Authorization).toBe('Bearer test-token');

    const body = JSON.parse((calledOpts.body as string) ?? '{}');
    expect(body.message.subject).toContain('abc12345');
    expect(body.message.toRecipients[0].emailAddress.address).toBe('olivier@dearborndenim.com');
    expect(body.message.body.content).toContain('/start abc12345');
  });

  it('returns ok=false when Graph sendMail returns non-2xx', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: () => Promise.resolve('{"error":"denied"}'),
    });
    const deps: SendInviteEmailDeps = {
      env: { INVITE_SENDER_EMAIL: 'rob@dearborndenim.com' },
      getGraphToken: async () => 'test-token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    };

    const result = await sendInviteEmail(
      { to: 'x@x.com', name: 'X', code: 'c' },
      deps,
    );

    expect(result.ok).toBe(false);
    expect(result.transport).toBe('graph');
    expect(result.error).toContain('401');
  });

  it('returns ok=false when getGraphToken throws', async () => {
    const deps: SendInviteEmailDeps = {
      env: { INVITE_SENDER_EMAIL: 'rob@dearborndenim.com' },
      getGraphToken: async () => {
        throw new Error('token fetch failed');
      },
      fetchImpl: vi.fn() as unknown as typeof fetch,
    };

    const result = await sendInviteEmail(
      { to: 'x@x.com', name: 'X', code: 'c' },
      deps,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('token fetch failed');
  });

  it('returns ok=false when fetch rejects (network error)', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const deps: SendInviteEmailDeps = {
      env: { INVITE_SENDER_EMAIL: 'rob@dearborndenim.com' },
      getGraphToken: async () => 'test-token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    };

    const result = await sendInviteEmail(
      { to: 'x@x.com', name: 'X', code: 'c' },
      deps,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('ECONNREFUSED');
  });

  it('defaults bot handle to @mcsecretary_bot when TELEGRAM_BOT_HANDLE unset', async () => {
    const logs: string[] = [];
    const deps: SendInviteEmailDeps = {
      env: {},
      logger: (line) => logs.push(line),
    };

    await sendInviteEmail({ to: 'x@x.com', name: 'X', code: 'c' }, deps);
    expect(logs[0]).toContain('@mcsecretary_bot');
  });

  it('honors TELEGRAM_BOT_HANDLE when set', async () => {
    const logs: string[] = [];
    const deps: SendInviteEmailDeps = {
      env: { TELEGRAM_BOT_HANDLE: '@custom_bot' },
      logger: (line) => logs.push(line),
    };

    await sendInviteEmail({ to: 'x@x.com', name: 'X', code: 'c' }, deps);
    expect(logs[0]).toContain('@custom_bot');
  });
});
