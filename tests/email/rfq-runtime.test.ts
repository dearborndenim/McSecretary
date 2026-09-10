import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { attachmentKind, postVendorQuote, saveRfqAttachments } from '../../src/email/rfq-runtime.js';
import { buildVendorQuoteBody } from '../../src/email/rfq-intake.js';
import type { RawEmail } from '../../src/email/types.js';

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
