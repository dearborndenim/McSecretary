/**
 * The built-in `email` hand (spec §12.4).
 *
 * An agent files a proposal whose `action_payload` is
 *   { hand: 'email', method: 'POST', path: '/send',
 *     body: { to, cc?, subject, text, html?, attachments?: [{url,name}], rfq_id? } }
 * and, once Robert approves the card, the executor calls `sendHandEmail` below:
 * the message goes out of Robert's Outlook mailbox through Microsoft Graph
 * `sendMail`, and a row lands in `rfq_messages` so the vendor's reply can be
 * correlated back to the RFQ.
 *
 * There is deliberately NO HTTP route that sends mail. The only way a message
 * leaves the mailbox is a proposal execution, which means a trust-ledger
 * decision (level 1 → Robert taps Approve) happened first.
 */

import type Database from 'better-sqlite3';
import { insertRfqMessage } from '../db/rfq-queries.js';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

/** Graph's own per-attachment ceiling for a simple (non-upload-session) send is 3 MB of base64; we cap the raw bytes below that headroom. */
export const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
export const MAX_ATTACHMENTS = 5;
export const MAX_RECIPIENTS = 10;
const SUBJECT_MAX = 300;
const TEXT_MAX = 20_000;
const HTML_MAX = 100_000;
const RFQ_ID_MAX = 128;
const NAME_MAX = 200;

export interface EmailAttachmentRef {
  url: string;
  name: string;
}

export interface EmailHandBody {
  to: string[];
  cc: string[];
  subject: string;
  text: string;
  html?: string;
  attachments: EmailAttachmentRef[];
  rfq_id: string | null;
}

const EMAIL_RE = /^[^\s@<>,]+@[^\s@<>,.]+(\.[^\s@<>,.]+)+$/;

function toList(v: unknown, field: string): { ok: true; list: string[] } | { ok: false; error: string } {
  const raw = v === undefined || v === null ? [] : Array.isArray(v) ? v : [v];
  if (raw.length > MAX_RECIPIENTS) return { ok: false, error: `${field} must have at most ${MAX_RECIPIENTS} addresses` };
  const list: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') return { ok: false, error: `${field} must be an email address or an array of them` };
    const addr = item.trim();
    if (!EMAIL_RE.test(addr)) return { ok: false, error: `${field} contains an invalid email address: ${addr.slice(0, 80)}` };
    list.push(addr);
  }
  return { ok: true, list };
}

/**
 * Validate an `email` hand payload. Returns the normalized body or the message
 * to record as the execution failure. Called from the executor (so a bad
 * payload fails the proposal instead of the send) and from the spine's HTTP
 * intake (so it is a 400 at file time, before Robert ever sees a card).
 */
export function validateEmailPayload(
  payload: { method: unknown; path: unknown; body: unknown },
): { ok: true; body: EmailHandBody } | { ok: false; error: string } {
  if (payload.method !== 'POST') return { ok: false, error: "action_payload.method must be POST for hand 'email'" };
  if (payload.path !== '/send') return { ok: false, error: "action_payload.path must be '/send' for hand 'email'" };
  const b = payload.body;
  if (typeof b !== 'object' || b === null || Array.isArray(b)) return { ok: false, error: 'action_payload.body must be an object' };
  const body = b as Record<string, unknown>;

  const to = toList(body.to, 'to');
  if (!to.ok) return to;
  if (to.list.length === 0) return { ok: false, error: 'to must name at least one recipient' };
  const cc = toList(body.cc, 'cc');
  if (!cc.ok) return cc;

  if (typeof body.subject !== 'string' || body.subject.trim().length === 0 || body.subject.length > SUBJECT_MAX) {
    return { ok: false, error: `subject must be a string of 1–${SUBJECT_MAX} chars` };
  }
  if (typeof body.text !== 'string' || body.text.trim().length === 0 || body.text.length > TEXT_MAX) {
    return { ok: false, error: `text must be a string of 1–${TEXT_MAX} chars` };
  }
  if (body.html !== undefined && (typeof body.html !== 'string' || body.html.length > HTML_MAX)) {
    return { ok: false, error: `html must be a string of at most ${HTML_MAX} chars` };
  }
  if (body.rfq_id !== undefined && body.rfq_id !== null
      && (typeof body.rfq_id !== 'string' || body.rfq_id.length === 0 || body.rfq_id.length > RFQ_ID_MAX)) {
    return { ok: false, error: `rfq_id must be a string of 1–${RFQ_ID_MAX} chars` };
  }

  const attachments: EmailAttachmentRef[] = [];
  if (body.attachments !== undefined) {
    if (!Array.isArray(body.attachments)) return { ok: false, error: 'attachments must be an array' };
    if (body.attachments.length > MAX_ATTACHMENTS) {
      return { ok: false, error: `attachments must have at most ${MAX_ATTACHMENTS} entries` };
    }
    for (const a of body.attachments) {
      if (typeof a !== 'object' || a === null || Array.isArray(a)) return { ok: false, error: 'each attachment must be an object' };
      const rec = a as Record<string, unknown>;
      if (typeof rec.url !== 'string' || !/^https?:\/\//i.test(rec.url)) {
        return { ok: false, error: 'each attachment needs an http(s) url' };
      }
      if (typeof rec.name !== 'string' || rec.name.length === 0 || rec.name.length > NAME_MAX) {
        return { ok: false, error: `each attachment needs a name of 1–${NAME_MAX} chars` };
      }
      attachments.push({ url: rec.url, name: rec.name });
    }
  }

  return {
    ok: true,
    body: {
      to: to.list,
      cc: cc.list,
      subject: body.subject,
      text: body.text,
      html: typeof body.html === 'string' ? body.html : undefined,
      attachments,
      rfq_id: typeof body.rfq_id === 'string' ? body.rfq_id : null,
    },
  };
}

const EXT_TYPES: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  pdf: 'application/pdf', csv: 'text/csv', txt: 'text/plain',
};

export function contentTypeFor(name: string, headerValue: string | null): string {
  const header = (headerValue ?? '').split(';')[0]!.trim().toLowerCase();
  if (header && header !== 'application/octet-stream' && header !== 'binary/octet-stream') return header;
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  return EXT_TYPES[ext] ?? 'application/octet-stream';
}

export interface GraphFileAttachment {
  '@odata.type': '#microsoft.graph.fileAttachment';
  name: string;
  contentType: string;
  contentBytes: string;
}

export interface GraphSendMailPayload {
  message: {
    subject: string;
    body: { contentType: 'HTML' | 'Text'; content: string };
    toRecipients: { emailAddress: { address: string } }[];
    ccRecipients: { emailAddress: { address: string } }[];
    attachments: GraphFileAttachment[];
  };
  saveToSentItems: true;
}

/** Build the Graph `sendMail` request body. Pure — the fetching of attachment bytes happens before this. */
export function buildSendMailPayload(body: EmailHandBody, attachments: GraphFileAttachment[]): GraphSendMailPayload {
  const useHtml = typeof body.html === 'string' && body.html.trim().length > 0;
  return {
    message: {
      subject: body.subject,
      body: { contentType: useHtml ? 'HTML' : 'Text', content: useHtml ? body.html! : body.text },
      toRecipients: body.to.map((address) => ({ emailAddress: { address } })),
      ccRecipients: body.cc.map((address) => ({ emailAddress: { address } })),
      attachments,
    },
    saveToSentItems: true,
  };
}

export interface EmailHandDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** Microsoft Graph app token (client credentials). */
  getGraphToken: () => Promise<string>;
  env: Record<string, string | undefined>;
  now: () => string;
  /** Correlation id sent as `client-request-id`; injected so tests are deterministic. */
  requestId?: () => string;
}

export interface EmailHandRequest {
  proposalId: number | null;
  brandId: string;
  /** The proposal's `evidence` object — `rfq_id` and the `intents` CSV come from it. */
  evidence: Record<string, unknown>;
  body: EmailHandBody;
}

export interface EmailHandSuccess {
  ok: true;
  http_status: number;
  body: {
    ok: true;
    notify: string;
    to: string;
    subject: string;
    rfq_id: string | null;
    attachments_sent: number;
    attachments_skipped: string[];
    graph_message_id: string | null;
  };
}

export interface EmailHandFailure {
  ok: false;
  http_status?: number;
  body?: unknown;
  error: string;
}

export type EmailHandResult = EmailHandSuccess | EmailHandFailure;

/** Where the message is sent from. Robert's mailbox unless RFQ_FROM_ADDRESS says otherwise. */
export function fromAddress(env: Record<string, string | undefined>): string {
  return (env.RFQ_FROM_ADDRESS || env.OUTLOOK_USER_EMAIL_1 || 'rob@dearborndenim.com').trim();
}

const TAG_RE = /\[DD-RFQ-([A-Za-z0-9][A-Za-z0-9._-]{0,127})\]/;

/** The RFQ id the send belongs to: the body's, the evidence's, or the one embedded in the subject tag. */
export function resolveRfqId(body: EmailHandBody, evidence: Record<string, unknown>): string {
  if (body.rfq_id) return body.rfq_id;
  if (typeof evidence.rfq_id === 'string' && evidence.rfq_id) return evidence.rfq_id;
  const m = TAG_RE.exec(body.subject);
  return m ? m[1]! : '';
}

function evidenceIntents(evidence: Record<string, unknown>): string {
  const v = evidence.intents;
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((x) => String(x)).join(',');
  if (typeof v === 'number') return String(v);
  return '';
}

async function fetchAttachment(
  deps: EmailHandDeps,
  ref: EmailAttachmentRef,
): Promise<{ ok: true; att: GraphFileAttachment } | { ok: false; why: string }> {
  let res: Response;
  try {
    res = await deps.fetch(ref.url, { method: 'GET' });
  } catch (err) {
    return { ok: false, why: err instanceof Error ? err.message : String(err) };
  }
  if (!res.ok) return { ok: false, why: `HTTP ${res.status}` };
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_ATTACHMENT_BYTES) return { ok: false, why: 'over 4 MB' };
  let buf: Buffer;
  try {
    buf = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    return { ok: false, why: err instanceof Error ? err.message : String(err) };
  }
  if (buf.byteLength === 0) return { ok: false, why: 'empty' };
  if (buf.byteLength > MAX_ATTACHMENT_BYTES) return { ok: false, why: 'over 4 MB' };
  return {
    ok: true,
    att: {
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: ref.name,
      contentType: contentTypeFor(ref.name, res.headers.get('content-type')),
      contentBytes: buf.toString('base64'),
    },
  };
}

/**
 * Send one message and record it in `rfq_messages`.
 *
 * Attachments are fetched by URL (design-module's public `/files/...` links, or
 * McSecretary's own `/files/rfq/...`), at most `MAX_ATTACHMENTS` of at most
 * `MAX_ATTACHMENT_BYTES` each. One that 404s, times out or is too large is
 * skipped and named in the notify line rather than failing the whole send —
 * a missing swatch must not stop the RFQ going out.
 *
 * Graph's `sendMail` answers 202 with an empty body and no message id, so the
 * `graph_message_id` column holds the Graph correlation id (`request-id`, or
 * the `client-request-id` we sent) — enough to trace the send in Graph's logs.
 * Reply correlation never depends on it: that runs off the `[DD-RFQ-<id>]`
 * subject tag and the vendor's domain.
 */
export async function sendHandEmail(
  db: Database.Database,
  req: EmailHandRequest,
  deps: EmailHandDeps,
): Promise<EmailHandResult> {
  const from = fromAddress(deps.env);
  if (!from) return { ok: false, error: 'No sending mailbox configured (set RFQ_FROM_ADDRESS)' };

  const skipped: string[] = [];
  const attachments: GraphFileAttachment[] = [];
  for (const ref of req.body.attachments.slice(0, MAX_ATTACHMENTS)) {
    const got = await fetchAttachment(deps, ref);
    if (got.ok) attachments.push(got.att);
    else skipped.push(`${ref.name} (${got.why})`);
  }

  const payload = buildSendMailPayload(req.body, attachments);

  let token: string;
  try {
    token = await deps.getGraphToken();
  } catch (err) {
    return { ok: false, error: `Graph token failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  const clientRequestId = deps.requestId ? deps.requestId() : cryptoRandomId();
  let res: Response;
  try {
    res = await deps.fetch(`${GRAPH_BASE}/users/${encodeURIComponent(from)}/sendMail`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'client-request-id': clientRequestId,
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return { ok: false, error: `Graph sendMail failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (!res.ok) {
    let text = '';
    try { text = await res.text(); } catch { /* body already consumed or unreadable */ }
    const capped = text.length > 2000 ? `${text.slice(0, 2000)}…[truncated]` : text;
    return {
      ok: false,
      http_status: res.status,
      body: capped,
      error: `Graph sendMail returned ${res.status}: ${capped}`,
    };
  }

  const graphMessageId = res.headers.get('request-id') ?? clientRequestId;
  const rfqId = resolveRfqId(req.body, req.evidence);
  const sentAt = deps.now();
  for (const vendorEmail of req.body.to) {
    insertRfqMessage(db, {
      rfq_id: rfqId,
      vendor_email: vendorEmail,
      subject: req.body.subject,
      graph_message_id: graphMessageId,
      sent_at: sentAt,
      proposal_id: req.proposalId,
      brand_id: req.brandId,
      intents: evidenceIntents(req.evidence),
    });
  }

  const base = `Sent to ${req.body.to.join(', ')}: ${req.body.subject}`;
  const notify = skipped.length > 0 ? `${base} — skipped ${skipped.length} attachment(s): ${skipped.join('; ')}` : base;

  return {
    ok: true,
    http_status: res.status,
    body: {
      ok: true,
      notify,
      to: req.body.to.join(', '),
      subject: req.body.subject,
      rfq_id: rfqId || null,
      attachments_sent: attachments.length,
      attachments_skipped: skipped,
      graph_message_id: graphMessageId,
    },
  };
}

function cryptoRandomId(): string {
  // Node 20+ always has webcrypto on globalThis.
  return globalThis.crypto.randomUUID();
}
