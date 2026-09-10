/**
 * The live wiring behind `processRfqReply` — the Anthropic extraction call, the
 * Graph attachment download, and the product-dev vendor-quote POST. Kept apart
 * from `rfq-intake.ts` so the intake logic stays pure and testable.
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  RFQ_EXTRACTION_OUTPUT_FORMAT, RFQ_EXTRACTION_SYSTEM_PROMPT, buildExtractionPrompt, parseRfqExtraction,
  MAX_ATTACHMENTS, type QuoteAttachment, type RfqExtraction, type VendorQuoteBody,
} from './rfq-intake.js';
import { newStorageId, rfqFileUrl, rfqPublicBaseUrl, rfqFilesDir, writeRfqFile } from './rfq-files.js';
import type { RawEmail } from './types.js';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

/** Same Haiku the per-email classifier uses — an option block is extraction, not judgement. */
export const RFQ_EXTRACTION_MODEL = 'claude-haiku-4-5-20251001';

let anthropicClient: Anthropic | null = null;

export async function extractRfqOptions(email: RawEmail): Promise<RfqExtraction> {
  if (!anthropicClient) {
    const { config } = await import('../config.js');
    anthropicClient = new Anthropic({ apiKey: config.anthropic.apiKey });
  }
  const response = await anthropicClient.messages.create({
    model: RFQ_EXTRACTION_MODEL,
    max_tokens: 2000,
    output_config: { format: RFQ_EXTRACTION_OUTPUT_FORMAT },
    system: RFQ_EXTRACTION_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildExtractionPrompt(email) }],
  });
  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');
  return parseRfqExtraction(text);
}

interface GraphAttachment {
  '@odata.type'?: string;
  id?: string;
  name?: string;
  contentType?: string;
  size?: number;
  isInline?: boolean;
  contentBytes?: string;
}

/** Attachments worth keeping: the swatch photo and the spec sheet. */
const KEEP_TYPES = /^(image\/(jpeg|png|gif|webp)|application\/pdf)$/i;
/** Graph will happily hand back a 20 MB TIFF; the volume is small and the gallery only needs a swatch. */
const MAX_SAVED_BYTES = 10 * 1024 * 1024;

export function attachmentKind(contentType: string): QuoteAttachment['kind'] {
  if (/^image\//i.test(contentType)) return 'image';
  if (/pdf/i.test(contentType)) return 'pdf';
  return 'file';
}

export interface SaveAttachmentsDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  getGraphToken: () => Promise<string>;
  env: Record<string, string | undefined>;
  /** Injected in tests. */
  storageId?: () => string;
}

/**
 * Download a reply's image/PDF attachments through Graph and put them in the
 * public RFQ file store. Returns the URLs to hang off the vendor quote.
 *
 * Best-effort by design: no public base URL configured, a Graph error, or an
 * attachment too big means fewer (or no) swatches on the quote, never a lost
 * quote. Inline images (signature logos) are skipped.
 */
export async function saveRfqAttachments(
  email: RawEmail,
  rfqId: string,
  deps: SaveAttachmentsDeps,
): Promise<QuoteAttachment[]> {
  const baseUrl = rfqPublicBaseUrl(deps.env);
  if (!baseUrl) {
    console.log('rfq: no PUBLIC_BASE_URL/BASE_URL — skipping attachment save');
    return [];
  }

  const token = await deps.getGraphToken();
  const url = `${GRAPH_BASE}/users/${encodeURIComponent(email.account)}/messages/${encodeURIComponent(email.id)}/attachments`;
  const res = await deps.fetch(url, { method: 'GET', headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Graph attachments (${res.status}) for message ${email.id}`);
  const data = (await res.json()) as { value?: GraphAttachment[] };

  const dir = rfqFilesDir(deps.env);
  const storageId = (deps.storageId ?? newStorageId)();
  const out: QuoteAttachment[] = [];

  for (const att of data.value ?? []) {
    if (out.length >= MAX_ATTACHMENTS) break;
    if (att['@odata.type'] && !att['@odata.type'].includes('fileAttachment')) continue;
    if (att.isInline) continue;
    const contentType = att.contentType ?? '';
    if (!KEEP_TYPES.test(contentType)) continue;
    if (typeof att.contentBytes !== 'string' || att.contentBytes.length === 0) continue;
    const bytes = Buffer.from(att.contentBytes, 'base64');
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_SAVED_BYTES) continue;
    try {
      const stored = writeRfqFile(dir, storageId, att.name ?? 'attachment', bytes);
      out.push({ url: rfqFileUrl(baseUrl, storageId, stored), name: stored, kind: attachmentKind(contentType) });
    } catch (err) {
      console.error(`rfq: failed to store attachment for ${rfqId}`, err);
    }
  }
  return out;
}

export interface PostVendorQuoteDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  env: Record<string, string | undefined>;
}

/**
 * File one option as a product-dev vendor quote. Reuses the hand's own
 * `PRODUCT_DEV_URL` / `PRODUCT_DEV_KEY` — this is the same service the spine
 * executor calls, just reached directly because triage is not a proposal.
 */
export async function postVendorQuote(
  body: VendorQuoteBody,
  deps: PostVendorQuoteDeps,
): Promise<{ ok: boolean; id: string | null; error?: string }> {
  const base = (deps.env.PRODUCT_DEV_URL ?? '').replace(/\/+$/, '');
  const key = deps.env.PRODUCT_DEV_KEY ?? '';
  if (!base || !key) return { ok: false, id: null, error: 'PRODUCT_DEV_URL/PRODUCT_DEV_KEY not configured' };

  const res = await deps.fetch(`${base}/api/integration/vendor-quotes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) return { ok: false, id: null, error: `product-dev ${res.status}: ${text.slice(0, 300)}` };
  let id: string | null = null;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const raw = parsed.id ?? (parsed.quote as Record<string, unknown> | undefined)?.id;
    if (typeof raw === 'string' || typeof raw === 'number') id = String(raw);
  } catch { /* a 2xx with an unreadable body still means it landed */ }
  return { ok: true, id };
}
