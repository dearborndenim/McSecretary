import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  attachmentKind, postVendorQuote, saveRfqAttachments, sendRfqAcknowledgement, RFQ_ACK_BODY,
} from '../../src/email/rfq-runtime.js';
import { buildVendorQuoteBody } from '../../src/email/rfq-intake.js';
import type { RfqMatch } from '../../src/email/rfq-intake.js';
import type { RawEmail } from '../../src/email/types.js';
import { initializeSchema } from '../../src/db/schema.js';
import { insertRfqMessage, listRfqMessages } from '../../src/db/rfq-queries.js';

const email: RawEmail = {
  id: 'AAMkAD==', account: 'rob@dearborndenim.com', sender: 'sales@carr.example', senderName: 'Carr',
  subject: 'RE: [DD-RFQ-r1] Fabric request', bodyPreview: '', body: '',
  receivedAt: '2026-09-12T08:00:00.000Z', threadId: 't', isRead: false,
};

const png = Buffer.from('PNGDATA').toString('base64');
const pdf = Buffer.from('PDFDATA').toString('base64');

function graphAttachments(value: unknown[]): Response {
  return new Response(JSON.stringify({ value }), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('attachmentKind', () => {
  it.each([['image/png', 'image'], ['application/pdf', 'pdf'], ['text/csv', 'file']])(
    '%s → %s', (t, k) => expect(attachmentKind(t)).toBe(k),
  );
});

describe('saveRfqAttachments', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfq-runtime-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const env = (over: Record<string, string> = {}) => ({
    PUBLIC_BASE_URL: 'https://mcs.example', RFQ_FILES_DIR: dir, ...over,
  });

  it('writes image and pdf attachments to the store and returns public URLs', async () => {
    const fetchMock = vi.fn(async () => graphAttachments([
      { '@odata.type': '#microsoft.graph.fileAttachment', name: 'swatch.png', contentType: 'image/png', contentBytes: png },
      { '@odata.type': '#microsoft.graph.fileAttachment', name: 'spec sheet.pdf', contentType: 'application/pdf', contentBytes: pdf },
    ]));
    const out = await saveRfqAttachments(email, 'r1', {
      fetch: fetchMock, getGraphToken: async () => 'tok', env: env(), storageId: () => 'a'.repeat(32),
    });

    expect(out).toEqual([
      { url: `https://mcs.example/files/rfq/${'a'.repeat(32)}/swatch.png`, name: 'swatch.png', kind: 'image' },
      { url: `https://mcs.example/files/rfq/${'a'.repeat(32)}/spec_sheet.pdf`, name: 'spec_sheet.pdf', kind: 'pdf' },
    ]);
    expect(fs.readFileSync(path.join(dir, 'a'.repeat(32), 'swatch.png')).toString()).toBe('PNGDATA');

    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('https://graph.microsoft.com/v1.0/users/rob%40dearborndenim.com/messages/AAMkAD%3D%3D/attachments');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('skips inline signature images, item attachments and unsupported types', async () => {
    const fetchMock = vi.fn(async () => graphAttachments([
      { '@odata.type': '#microsoft.graph.fileAttachment', name: 'logo.png', contentType: 'image/png', contentBytes: png, isInline: true },
      { '@odata.type': '#microsoft.graph.itemAttachment', name: 'fwd.msg', contentType: 'message/rfc822' },
      { '@odata.type': '#microsoft.graph.fileAttachment', name: 'macro.xlsm', contentType: 'application/vnd.ms-excel', contentBytes: png },
      { '@odata.type': '#microsoft.graph.fileAttachment', name: 'keep.png', contentType: 'image/png', contentBytes: png },
    ]));
    const out = await saveRfqAttachments(email, 'r1', {
      fetch: fetchMock, getGraphToken: async () => 'tok', env: env(), storageId: () => 'b'.repeat(32),
    });
    expect(out.map((a) => a.name)).toEqual(['keep.png']);
  });

  it('returns nothing (and never calls Graph) with no public base URL configured', async () => {
    const fetchMock = vi.fn();
    const out = await saveRfqAttachments(email, 'r1', {
      fetch: fetchMock as never, getGraphToken: async () => 'tok', env: { RFQ_FILES_DIR: dir },
    });
    expect(out).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws on a Graph error so the caller records it and still files the quotes', async () => {
    await expect(saveRfqAttachments(email, 'r1', {
      fetch: async () => new Response('nope', { status: 503 }),
      getGraphToken: async () => 'tok',
      env: env(),
    })).rejects.toThrow(/503/);
  });
});

describe('postVendorQuote', () => {
  const body = buildVendorQuoteBody(
    {
      style_number: 'CT-4410', price_per_yard_usd: 6.75, weight_oz: 5.5, width_in: 57,
      content: '100% linen', moq: 300, moq_unit: 'yards', lead_days: 21, notes: null,
    },
    { fabricIntentId: 'fi_1', vendorName: 'Carr', rfqId: 'r1', attachments: [] },
  );

  it('POSTs to product-dev with its bearer and returns the created id', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'vq_9' }), { status: 201 }));
    const r = await postVendorQuote(body, {
      fetch: fetchMock, env: { PRODUCT_DEV_URL: 'https://pd.example/', PRODUCT_DEV_KEY: 'pdkey' },
    });
    expect(r).toEqual({ ok: true, id: 'vq_9' });
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('https://pd.example/api/integration/vendor-quotes');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer pdkey');
    expect(JSON.parse(init.body as string)).toEqual(body);
  });

  it('reads an id nested under `quote`', async () => {
    const r = await postVendorQuote(body, {
      fetch: async () => new Response(JSON.stringify({ quote: { id: 7 } }), { status: 200 }),
      env: { PRODUCT_DEV_URL: 'https://pd.example', PRODUCT_DEV_KEY: 'k' },
    });
    expect(r).toEqual({ ok: true, id: '7' });
  });

  it('reports a non-2xx with the upstream text', async () => {
    const r = await postVendorQuote(body, {
      fetch: async () => new Response('unknown fabricIntentId', { status: 422 }),
      env: { PRODUCT_DEV_URL: 'https://pd.example', PRODUCT_DEV_KEY: 'k' },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/422: unknown fabricIntentId/);
  });

  it('refuses to call anything when product-dev is not configured', async () => {
    const fetchMock = vi.fn();
    const r = await postVendorQuote(body, { fetch: fetchMock as never, env: {} });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/PRODUCT_DEV_URL/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('sendRfqAcknowledgement', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); initializeSchema(db); });
  afterEach(() => db.close());

  function seedMatch(): RfqMatch {
    const rowId = insertRfqMessage(db, {
      rfq_id: 'r1', vendor_email: 'sales@carr.example', subject: '[DD-RFQ-r1] Fabric request',
      graph_message_id: 'g0', sent_at: '2026-09-10T00:00:00.000Z', proposal_id: 12,
      brand_id: 'dearborn-denim', intents: 'fi_1,fi_2',
    });
    return {
      id: rowId, rfq_id: 'r1', vendor_email: 'sales@carr.example', vendor_domain: 'carr.example',
      intents: ['fi_1', 'fi_2'], proposal_id: 12, brand_id: 'dearborn-denim', matched_by: 'tag',
    };
  }

  it('replies in the vendor thread with the exact body, no from/replyTo override when no alias is configured', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 202 }));
    const match = seedMatch();
    const r = await sendRfqAcknowledgement(email, match, {
      db, fetch: fetchMock, getGraphToken: async () => 'tok', env: {}, now: () => '2026-09-12T09:00:00.000Z',
    });
    expect(r).toEqual({ ok: true, method: 'reply' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('https://graph.microsoft.com/v1.0/users/rob%40dearborndenim.com/messages/AAMkAD%3D%3D/reply');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    const payload = JSON.parse(init.body as string);
    expect(payload.comment).toBe(RFQ_ACK_BODY);
    expect(payload.message).toBeUndefined();
  });

  it('stamps message.from/replyTo with the alias when RFQ_FROM_ADDRESS differs from RFQ_MAILBOX', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 202 }));
    const match = seedMatch();
    await sendRfqAcknowledgement(email, match, {
      db, fetch: fetchMock, getGraphToken: async () => 'tok',
      env: { RFQ_MAILBOX: 'rob@dearborndenim.com', RFQ_FROM_ADDRESS: 'sourcing@dearborndenim.com' },
      now: () => '2026-09-12T09:00:00.000Z',
    });
    const payload = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    const expected = { emailAddress: { address: 'sourcing@dearborndenim.com', name: 'Dearborn Denim Sourcing' } };
    expect(payload.message.from).toEqual(expected);
    expect(payload.message.replyTo).toEqual([expected]);
  });

  it('falls back to sendMail with a Re: subject and the conversationId when reply fails', async () => {
    const fetchMock = vi.fn(async (url: string) => (
      url.includes('/reply')
        ? new Response('gone', { status: 404 })
        : new Response('', { status: 202 })
    ));
    const match = seedMatch();
    const plainSubject = { ...email, subject: 'Fabric request follow-up' };
    const r = await sendRfqAcknowledgement(plainSubject, match, {
      db, fetch: fetchMock, getGraphToken: async () => 'tok', env: {}, now: () => '2026-09-12T09:00:00.000Z',
    });
    expect(r).toEqual({ ok: true, method: 'sendMail' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [sendUrl, init] = fetchMock.mock.calls[1]! as unknown as [string, RequestInit];
    expect(sendUrl).toBe('https://graph.microsoft.com/v1.0/users/rob%40dearborndenim.com/sendMail');
    const payload = JSON.parse(init.body as string);
    expect(payload.message.subject).toBe('Re: Fabric request follow-up');
    expect(payload.message.conversationId).toBe('t');
    expect(payload.message.body).toEqual({ contentType: 'Text', content: RFQ_ACK_BODY });
    expect(payload.message.toRecipients).toEqual([{ emailAddress: { address: 'sales@carr.example' } }]);
  });

  it('does not double-prefix a subject that already reads Re:', async () => {
    const fetchMock = vi.fn(async (url: string) => (url.includes('/reply') ? new Response('gone', { status: 404 }) : new Response('', { status: 202 })));
    const match = seedMatch();
    await sendRfqAcknowledgement({ ...email, subject: 'RE: [DD-RFQ-r1] Fabric request' }, match, {
      db, fetch: fetchMock, getGraphToken: async () => 'tok', env: {}, now: () => '2026-09-12T09:00:00.000Z',
    });
    const payload = JSON.parse((fetchMock.mock.calls[1]![1] as RequestInit).body as string);
    expect(payload.message.subject).toBe('RE: [DD-RFQ-r1] Fabric request');
  });

  it('records acknowledged_at + the inbound message id on the matched rfq_messages row', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 202 }));
    const match = seedMatch();
    await sendRfqAcknowledgement(email, match, {
      db, fetch: fetchMock, getGraphToken: async () => 'tok', env: {}, now: () => '2026-09-12T09:00:00.000Z',
    });
    const rows = listRfqMessages(db, 'r1');
    expect(rows[0]!.ack_message_id).toBe('AAMkAD==');
    expect(rows[0]!.acknowledged_at).toBe('2026-09-12T09:00:00.000Z');
  });

  it('is idempotent: a second call for the same inbound message id sends nothing', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 202 }));
    const match = seedMatch();
    const deps = { db, fetch: fetchMock, getGraphToken: async () => 'tok', env: {}, now: () => '2026-09-12T09:00:00.000Z' };
    const first = await sendRfqAcknowledgement(email, match, deps);
    const second = await sendRfqAcknowledgement(email, match, deps);
    expect(first).toEqual({ ok: true, method: 'reply' });
    expect(second).toEqual({ ok: true, skipped: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports failure when both reply and the sendMail fallback fail', async () => {
    const fetchMock = vi.fn(async () => new Response('nope', { status: 500 }));
    const match = seedMatch();
    const r = await sendRfqAcknowledgement(email, match, {
      db, fetch: fetchMock, getGraphToken: async () => 'tok', env: {}, now: () => '2026-09-12T09:00:00.000Z',
    });
    expect(r.ok).toBe(false);
    expect(r.method).toBe('sendMail');
    expect(r.error).toMatch(/500/);
    expect(listRfqMessages(db, 'r1')[0]!.acknowledged_at).toBeNull();
  });

  it('never throws when Graph is unreachable', async () => {
    const match = seedMatch();
    const r = await sendRfqAcknowledgement(email, match, {
      db, fetch: async () => { throw new Error('ECONNRESET'); }, getGraphToken: async () => 'tok', env: {}, now: () => '2026-09-12T09:00:00.000Z',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/ECONNRESET/);
  });
});
