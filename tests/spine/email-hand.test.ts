import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import { insertProposal, getProposalById } from '../../src/db/proposal-queries.js';
import { executeProposal, type ExecutorDeps } from '../../src/spine/executor.js';
import {
  sendHandEmail, validateEmailPayload, buildSendMailPayload, contentTypeFor, fromAddress, resolveRfqId,
  type EmailHandBody, type EmailHandDeps,
} from '../../src/spine/email-hand.js';
import { listRfqMessages } from '../../src/db/rfq-queries.js';
import type { BrandConfig } from '../../src/spine/brand-config.js';

const NOW = '2026-09-10T12:00:00.000Z';

const brand: BrandConfig = {
  brand_id: 'dearborn-denim', display_name: 'DD', inbox_user_id: 'robert-mcmillan',
  shopify_store: 's', meta_ad_account: 'm', silent_budget_usd: 500, exploration_share: 0.2,
  proposal_expiry_hours: 48,
  hands: { 'product-dev': { url_env: 'PD_URL', key_env: 'PD_KEY' } },
};

const BODY = {
  to: 'sales@carrtextiles.example',
  subject: '[DD-RFQ-linen-spring27-carr-20260910] Fabric request — Dearborn Denim, Spring 27',
  text: 'We are after a mid-weight linen. Please reply with style number, price/yd, weight, width, content, minimum and lead time.',
  attachments: [{ url: 'https://design.example/files/concepts/linen-shirt.png', name: 'linen-shirt.png' }],
  rfq_id: 'linen-spring27-carr-20260910',
};

function normalized(over: Partial<Record<string, unknown>> = {}): EmailHandBody {
  const v = validateEmailPayload({ method: 'POST', path: '/send', body: { ...BODY, ...over } });
  if (!v.ok) throw new Error(v.error);
  return v.body;
}

describe('validateEmailPayload', () => {
  it('normalizes a single recipient into a list and defaults cc/attachments', () => {
    const v = validateEmailPayload({ method: 'POST', path: '/send', body: { to: 'a@b.com', subject: 's', text: 't' } });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.body.to).toEqual(['a@b.com']);
      expect(v.body.cc).toEqual([]);
      expect(v.body.attachments).toEqual([]);
      expect(v.body.rfq_id).toBeNull();
    }
  });

  it('accepts an array of recipients and a cc list', () => {
    const v = validateEmailPayload({
      method: 'POST', path: '/send',
      body: { to: ['a@b.com', 'c@d.com'], cc: 'rob@dearborndenim.com', subject: 's', text: 't' },
    });
    expect(v.ok && v.body.to).toEqual(['a@b.com', 'c@d.com']);
    expect(v.ok && v.body.cc).toEqual(['rob@dearborndenim.com']);
  });

  it.each([
    [{ method: 'GET' }, /must be POST/],
    [{ path: '/api/x' }, /must be '\/send'/],
    [{ body: { ...BODY, to: 'not-an-email' } }, /invalid email address/],
    [{ body: { ...BODY, to: [] } }, /at least one recipient/],
    [{ body: { ...BODY, subject: '' } }, /subject must be/],
    [{ body: { ...BODY, text: '   ' } }, /text must be/],
    [{ body: { ...BODY, attachments: [{ url: 'file:///etc/passwd', name: 'x' }] } }, /http\(s\) url/],
    [{ body: { ...BODY, attachments: Array.from({ length: 6 }, () => ({ url: 'https://x/y', name: 'n' })) } }, /at most 5/],
    [{ body: { ...BODY, rfq_id: 42 } }, /rfq_id must be/],
  ])('refuses %j', (over, pattern) => {
    const v = validateEmailPayload({ method: 'POST', path: '/send', body: BODY, ...over } as never);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toMatch(pattern);
  });
});

describe('buildSendMailPayload', () => {
  it('sends plain text with no html, and Graph-shaped recipients', () => {
    const p = buildSendMailPayload(normalized(), []);
    expect(p.message.body).toEqual({ contentType: 'Text', content: BODY.text });
    expect(p.message.toRecipients).toEqual([{ emailAddress: { address: 'sales@carrtextiles.example' } }]);
    expect(p.message.ccRecipients).toEqual([]);
    expect(p.saveToSentItems).toBe(true);
  });

  it('prefers html when the agent supplied one', () => {
    const p = buildSendMailPayload(normalized({ html: '<p>hi</p>' }), []);
    expect(p.message.body).toEqual({ contentType: 'HTML', content: '<p>hi</p>' });
  });
});

describe('contentTypeFor', () => {
  it.each([
    ['swatch.png', null, 'image/png'],
    ['spec.pdf', 'application/octet-stream', 'application/pdf'],
    ['x.jpg', 'image/jpeg; charset=binary', 'image/jpeg'],
    ['mystery', null, 'application/octet-stream'],
  ])('%s → %s', (name, header, expected) => {
    expect(contentTypeFor(name, header)).toBe(expected);
  });
});

describe('fromAddress / resolveRfqId', () => {
  it('sends from RFQ_FROM_ADDRESS, falling back to Robert', () => {
    expect(fromAddress({ RFQ_FROM_ADDRESS: 'sourcing@dearborndenim.com' })).toBe('sourcing@dearborndenim.com');
    expect(fromAddress({})).toBe('rob@dearborndenim.com');
  });

  it('takes the rfq id from the body, then evidence, then the subject tag', () => {
    expect(resolveRfqId(normalized(), {})).toBe('linen-spring27-carr-20260910');
    expect(resolveRfqId(normalized({ rfq_id: undefined }), { rfq_id: 'from-evidence' })).toBe('from-evidence');
    expect(resolveRfqId(normalized({ rfq_id: undefined }), {})).toBe('linen-spring27-carr-20260910');
    expect(resolveRfqId(normalized({ rfq_id: undefined, subject: 'no tag here' }), {})).toBe('');
  });
});

function handDeps(fetchImpl: EmailHandDeps['fetch'], env: Record<string, string | undefined> = {}): EmailHandDeps {
  return {
    fetch: fetchImpl,
    getGraphToken: async () => 'graph-token',
    env: { RFQ_FROM_ADDRESS: 'rob@dearborndenim.com', ...env },
    now: () => NOW,
    requestId: () => 'req-1',
  };
}

describe('sendHandEmail', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); initializeSchema(db); });
  afterEach(() => db.close());

  it('fetches attachments by URL, base64s them into the Graph payload, and records rfq_messages', async () => {
    const png = Buffer.from('fake-png-bytes');
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith('https://design.example/')) {
        return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
      }
      return new Response('', { status: 202, headers: { 'request-id': 'graph-req-9' } });
    });

    const r = await sendHandEmail(db, {
      proposalId: 12, brandId: 'dearborn-denim',
      evidence: { rfq_id: 'linen-spring27-carr-20260910', intents: 'fi_1,fi_2', vendor: 'Carr Textiles' },
      body: normalized(),
    }, handDeps(fetchMock as unknown as EmailHandDeps['fetch']));

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.http_status).toBe(202);
    expect(r.body.notify).toBe(`Sent to sales@carrtextiles.example: ${BODY.subject}`);
    expect(r.body.attachments_sent).toBe(1);
    expect(r.body.graph_message_id).toBe('graph-req-9');

    const [sendUrl, init] = fetchMock.mock.calls[1]! as unknown as [string, RequestInit];
    expect(sendUrl).toBe('https://graph.microsoft.com/v1.0/users/rob%40dearborndenim.com/sendMail');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer graph-token');
    const payload = JSON.parse(init.body as string);
    expect(payload.message.attachments).toEqual([{
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: 'linen-shirt.png',
      contentType: 'image/png',
      contentBytes: png.toString('base64'),
    }]);

    const rows = listRfqMessages(db, 'linen-spring27-carr-20260910');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      vendor_email: 'sales@carrtextiles.example',
      vendor_domain: 'carrtextiles.example',
      subject: BODY.subject,
      graph_message_id: 'graph-req-9',
      sent_at: NOW,
      proposal_id: 12,
      brand_id: 'dearborn-denim',
      intents: 'fi_1,fi_2',
    });
  });

  it('records one rfq_messages row per recipient', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 202 }));
    await sendHandEmail(db, {
      proposalId: 1, brandId: 'dearborn-denim', evidence: { intents: ['fi_1'] },
      body: normalized({ to: ['a@one.example', 'b@two.example'], attachments: [] }),
    }, handDeps(fetchMock as unknown as EmailHandDeps['fetch']));
    const rows = listRfqMessages(db, 'linen-spring27-carr-20260910');
    expect(rows.map((r) => r.vendor_domain)).toEqual(['one.example', 'two.example']);
    expect(rows[0]!.intents).toBe('fi_1');
  });

  it('skips an attachment that 404s and names it in notify, still sending the mail', async () => {
    const fetchMock = vi.fn(async (url: string) => (
      url.startsWith('https://design.example/')
        ? new Response('gone', { status: 404 })
        : new Response('', { status: 202 })
    ));
    const r = await sendHandEmail(db, {
      proposalId: 3, brandId: 'dearborn-denim', evidence: {}, body: normalized(),
    }, handDeps(fetchMock as unknown as EmailHandDeps['fetch']));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body.attachments_sent).toBe(0);
    expect(r.body.attachments_skipped).toEqual(['linen-shirt.png (HTTP 404)']);
    expect(r.body.notify).toMatch(/skipped 1 attachment\(s\): linen-shirt\.png \(HTTP 404\)/);
    const payload = JSON.parse((fetchMock.mock.calls[1]![1] as RequestInit).body as string);
    expect(payload.message.attachments).toEqual([]);
  });

  it('skips an attachment over 4 MB by its declared length without downloading it twice', async () => {
    const fetchMock = vi.fn(async (url: string) => (
      url.startsWith('https://design.example/')
        ? new Response('x', { status: 200, headers: { 'content-length': String(5 * 1024 * 1024) } })
        : new Response('', { status: 202 })
    ));
    const r = await sendHandEmail(db, {
      proposalId: 4, brandId: 'dearborn-denim', evidence: {}, body: normalized(),
    }, handDeps(fetchMock as unknown as EmailHandDeps['fetch']));
    expect(r.ok && r.body.attachments_skipped).toEqual(['linen-shirt.png (over 4 MB)']);
  });

  it('returns the Graph failure and writes no rfq_messages row on a 4xx', async () => {
    const fetchMock = vi.fn(async (url: string) => (
      url.startsWith('https://design.example/')
        ? new Response('png', { status: 200 })
        : new Response(JSON.stringify({ error: { code: 'ErrorInvalidRecipients' } }), { status: 400 })
    ));
    const r = await sendHandEmail(db, {
      proposalId: 5, brandId: 'dearborn-denim', evidence: {}, body: normalized(),
    }, handDeps(fetchMock as unknown as EmailHandDeps['fetch']));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.http_status).toBe(400);
    expect(r.error).toMatch(/ErrorInvalidRecipients/);
    expect(listRfqMessages(db, 'linen-spring27-carr-20260910')).toEqual([]);
  });

  it('never throws when Graph is unreachable', async () => {
    const r = await sendHandEmail(db, {
      proposalId: 6, brandId: 'dearborn-denim', evidence: {}, body: normalized({ attachments: [] }),
    }, handDeps(async () => { throw new Error('ECONNRESET'); }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/ECONNRESET/);
  });
});

describe('executeProposal with the built-in email hand', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); initializeSchema(db); });
  afterEach(() => db.close());

  function file(over: Partial<{ path: string; body: Record<string, unknown> }> = {}): number {
    return insertProposal(db, {
      agent: 'sourcing', brand_id: 'dearborn-denim', action_type: 'rfq_send',
      action_payload: { hand: 'email', method: 'POST', path: '/send', body: BODY, ...over },
      reason: 'RFQ to Carr Textiles',
      evidence: { rfq_id: 'linen-spring27-carr-20260910', intents: 'fi_1,fi_2', vendor: 'Carr Textiles', family: 'linen' },
      cost_usd: 0, reversible: false, level_required: 1, expires_at: '2026-09-12T00:00:00.000Z',
    }, NOW).id;
  }

  function deps(sendEmail?: ExecutorDeps['sendEmail']): ExecutorDeps {
    return {
      fetch: async () => { throw new Error('the email hand must not make a hand HTTP call'); },
      env: {}, loadBrand: () => brand, now: () => NOW, sendEmail,
    };
  }

  it('routes to sendEmail with the normalized body and the proposal evidence, and marks executed', async () => {
    const sendEmail = vi.fn(async () => ({
      ok: true as const, http_status: 202,
      body: {
        ok: true as const, notify: 'Sent to sales@carrtextiles.example: subject',
        to: 'sales@carrtextiles.example', subject: 'subject', rfq_id: 'linen-spring27-carr-20260910',
        attachments_sent: 1, attachments_skipped: [], graph_message_id: 'g1',
      },
    }));
    const id = file();
    const r = await executeProposal(db, id, deps(sendEmail));
    expect(r.ok).toBe(true);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const req = sendEmail.mock.calls[0]![0] as { evidence: Record<string, unknown>; body: EmailHandBody };
    expect(req.evidence.intents).toBe('fi_1,fi_2');
    expect(req.body.to).toEqual(['sales@carrtextiles.example']);
    expect(getProposalById(db, id)!.status).toBe('executed');
  });

  it('emits rfq_send_executed so Sourcing wakes on the chain', async () => {
    const id = file();
    await executeProposal(db, id, deps(async () => ({
      ok: true as const, http_status: 202,
      body: {
        ok: true as const, notify: 'n', to: 't', subject: 's', rfq_id: 'r',
        attachments_sent: 0, attachments_skipped: [], graph_message_id: null,
      },
    })));
    const events = db.prepare('SELECT event_type, urgent FROM spine_events').all() as { event_type: string; urgent: number }[];
    expect(events).toEqual([{ event_type: 'rfq_send_executed', urgent: 1 }]);
  });

  it('marks execution_failed when Graph answers 4xx', async () => {
    const id = file();
    const r = await executeProposal(db, id, deps(async () => ({
      ok: false as const, http_status: 400, body: 'bad recipients', error: 'Graph sendMail returned 400: bad recipients',
    })));
    expect(r.ok).toBe(false);
    const row = getProposalById(db, id)!;
    expect(row.status).toBe('failed');
    expect(JSON.parse(row.execution_result!)).toMatchObject({ http_status: 400 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM spine_events').get()).toEqual({ n: 0 });
  });

  it('fails a malformed payload before any send is attempted', async () => {
    const sendEmail = vi.fn();
    const id = file({ path: '/hands/email/send' });
    const r = await executeProposal(db, id, deps(sendEmail as unknown as ExecutorDeps['sendEmail']));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/must be '\/send'/);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(getProposalById(db, id)!.status).toBe('failed');
  });

  it('fails cleanly when the instance cannot send mail at all', async () => {
    const id = file();
    const r = await executeProposal(db, id, deps(undefined));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Email hand is not configured/);
    expect(getProposalById(db, id)!.status).toBe('failed');
  });
});
