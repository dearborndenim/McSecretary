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
import { resolveHand, type BrandConfig } from './brand-config.js';

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
const VENDOR_NAME_MAX = 200;

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
  /**
   * The vendor's display name, when the sender (Sourcing) knows it — e.g. the
   * registry's `name` for the vendor an RFQ went to. Recorded on the outbound
   * `rfq_messages` row and used verbatim as `vendorName` on every quote a
   * reply to this RFQ produces (see `vendorNameFor`, `src/email/rfq-intake.ts`).
   * Never the sender's own display name — that is untrusted, vendor-supplied
   * text. Absent (or blank), the row falls back to the recipient's domain,
   * title-cased.
   */
  vendor_name: string | null;
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
  if (body.vendor_name !== undefined && body.vendor_name !== null
      && (typeof body.vendor_name !== 'string' || body.vendor_name.trim().length === 0 || body.vendor_name.length > VENDOR_NAME_MAX)) {
    return { ok: false, error: `vendor_name must be a string of 1–${VENDOR_NAME_MAX} chars` };
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
      vendor_name: typeof body.vendor_name === 'string' ? body.vendor_name.trim() : null,
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
    from?: { emailAddress: { address: string; name: string } };
    replyTo?: { emailAddress: { address: string; name: string } }[];
  };
  saveToSentItems: true;
}

/** Display name stamped on `message.from`/`replyTo` when the alias differs from the sending mailbox. */
export const RFQ_SENDER_NAME = 'Dearborn Denim Sourcing';

export interface EmailSender {
  /** The Graph mailbox the send goes through: `/users/{mailbox}/sendMail`. */
  mailbox: string;
  /** The address shown as the sender. Same as `mailbox` unless RFQ_FROM_ADDRESS names an alias. */
  from: string;
}

/**
 * Build the Graph `sendMail` request body. Pure — the fetching of attachment bytes happens before this.
 * `sender` is optional so existing callers that only care about body/recipients are unaffected; when
 * given and `sender.from` differs from `sender.mailbox`, the payload sets `message.from`/`replyTo` to
 * the alias — Exchange must have send-from-alias enabled and the alias must belong to that mailbox, or
 * Graph answers 403/400 on the send.
 */
export function buildSendMailPayload(
  body: EmailHandBody,
  attachments: GraphFileAttachment[],
  sender?: EmailSender,
): GraphSendMailPayload {
  const useHtml = typeof body.html === 'string' && body.html.trim().length > 0;
  const payload: GraphSendMailPayload = {
    message: {
      subject: body.subject,
      body: { contentType: useHtml ? 'HTML' : 'Text', content: useHtml ? body.html! : body.text },
      toRecipients: body.to.map((address) => ({ emailAddress: { address } })),
      ccRecipients: body.cc.map((address) => ({ emailAddress: { address } })),
      attachments,
    },
    saveToSentItems: true,
  };
  if (sender && sender.from !== sender.mailbox) {
    const addr = { emailAddress: { address: sender.from, name: RFQ_SENDER_NAME } };
    payload.message.from = addr;
    payload.message.replyTo = [addr];
  }
  return payload;
}

export interface EmailHandDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** Microsoft Graph app token (client credentials). */
  getGraphToken: () => Promise<string>;
  env: Record<string, string | undefined>;
  now: () => string;
  /** Correlation id sent as `client-request-id`; injected so tests are deterministic. */
  requestId?: () => string;
  /**
   * Resolves a brand's config so an attachment fetch can find the `design-module`
   * hand's own base URL and bearer (see `designModuleTarget`, below). Optional so
   * existing callers that never attach a design-module URL are unaffected; when
   * absent, every attachment fetch is unauthenticated exactly as before.
   */
  loadBrand?: (brandId: string) => BrandConfig;
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

/**
 * The Graph mailbox the send actually goes through — `/users/{mailbox}/sendMail`.
 * RFQ_MAILBOX, falling back to Robert's own mailbox.
 */
export function mailboxAddress(env: Record<string, string | undefined>): string {
  return (env.RFQ_MAILBOX || env.OUTLOOK_USER_EMAIL_1 || 'rob@dearborndenim.com').trim();
}

/**
 * The address shown as the sender. RFQ_FROM_ADDRESS, falling back to the sending mailbox itself —
 * so an instance with no alias configured behaves exactly as before the mailbox/alias split.
 */
export function fromAddress(env: Record<string, string | undefined>): string {
  return (env.RFQ_FROM_ADDRESS || mailboxAddress(env)).trim();
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

/** The proposal's `evidence.vendor` (a registry slug, e.g. "carr-textile") — recorded for traceability only, never used to name a vendor quote. */
function evidenceVendorSlug(evidence: Record<string, unknown>): string | null {
  const v = evidence.vendor;
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

/**
 * Title-case the registrable part of a domain: `carrtextile.com` → `Carrtextile`,
 * `mail.carrtextile.co.uk` → `Co` (a multi-label suffix is not special-cased —
 * this is a last-resort fallback for when Sourcing did not supply a
 * `vendor_name`, not an attempt at real domain parsing).
 */
export function deriveVendorNameFromDomain(domain: string): string {
  const parts = domain.split('.').filter((p) => p.length > 0);
  if (parts.length === 0) return domain;
  const label = parts.length > 1 ? parts[parts.length - 2]! : parts[0]!;
  return label.charAt(0).toUpperCase() + label.slice(1).toLowerCase();
}

/**
 * The display name a reply to this vendor's quotes get filed under
 * (`vendorNameFor`, `src/email/rfq-intake.ts` reads it off the resulting
 * `rfq_messages` row) — the body's own `vendor_name` when Sourcing supplied
 * one, else the recipient's own domain, title-cased. Never the sender's
 * display name; that is decided later, from the *inbound* reply, and is
 * untrusted vendor-supplied text.
 */
export function resolveVendorName(body: EmailHandBody, vendorEmail: string): string {
  if (body.vendor_name) return body.vendor_name;
  const domain = vendorEmail.slice(vendorEmail.lastIndexOf('@') + 1).trim().toLowerCase();
  return domain ? deriveVendorNameFromDomain(domain) : vendorEmail;
}

/**
 * The brand's own `design-module` hand — url + bearer — when the brand config names one
 * and its env vars are set; `null` otherwise (no hand registered, or misconfigured). Never
 * throws: an attachment fetch falls back to unauthenticated rather than failing the whole
 * send over a hand lookup problem.
 */
function designModuleTarget(deps: EmailHandDeps, brandId: string): { url: string; bearer: string } | null {
  if (!deps.loadBrand) return null;
  try {
    const brand = deps.loadBrand(brandId);
    return resolveHand(brand, 'design-module', deps.env);
  } catch {
    return null;
  }
}

/** True when `url`'s host is exactly the `design-module` hand's own host. Never throws. */
function isDesignModuleUrl(url: string, target: { url: string; bearer: string } | null): boolean {
  if (!target) return false;
  try {
    return new URL(url).host === new URL(target.url).host;
  } catch {
    return false;
  }
}

async function fetchAttachment(
  deps: EmailHandDeps,
  ref: EmailAttachmentRef,
  dmTarget: { url: string; bearer: string } | null,
): Promise<{ ok: true; att: GraphFileAttachment } | { ok: false; why: string }> {
  // design-module's /files/... route is bearer-gated; every other host is fetched exactly
  // as before, unauthenticated. Never logged — the header is built and used, never printed.
  const headers = isDesignModuleUrl(ref.url, dmTarget) ? { Authorization: `Bearer ${dmTarget!.bearer}` } : undefined;
  let res: Response;
  try {
    res = await deps.fetch(ref.url, { method: 'GET', ...(headers ? { headers } : {}) });
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
 * Attachments are fetched by URL (design-module's bearer-gated `/files/...` links, or
 * McSecretary's own `/files/rfq/...`), at most `MAX_ATTACHMENTS` of at most
 * `MAX_ATTACHMENT_BYTES` each. A URL whose host is the brand's own `design-module`
 * hand (per `loadBrand`/`resolveHand`) is fetched with that hand's bearer; every
 * other host is fetched unauthenticated, exactly as before — see `designModuleTarget`.
 * One that 401s, 404s, times out or is too large is skipped and named in the notify
 * line rather than failing the whole send — a missing swatch must not stop the RFQ
 * going out.
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
  const mailbox = mailboxAddress(deps.env);
  if (!mailbox) return { ok: false, error: 'No sending mailbox configured (set RFQ_MAILBOX or RFQ_FROM_ADDRESS)' };
  const from = fromAddress(deps.env);
  const sender: EmailSender = { mailbox, from };

  const dmTarget = designModuleTarget(deps, req.brandId);
  const skipped: string[] = [];
  const attachments: GraphFileAttachment[] = [];
  for (const ref of req.body.attachments.slice(0, MAX_ATTACHMENTS)) {
    const got = await fetchAttachment(deps, ref, dmTarget);
    if (got.ok) attachments.push(got.att);
    else skipped.push(`${ref.name} (${got.why})`);
  }

  const payload = buildSendMailPayload(req.body, attachments, sender);

  let token: string;
  try {
    token = await deps.getGraphToken();
  } catch (err) {
    return { ok: false, error: `Graph token failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  const clientRequestId = deps.requestId ? deps.requestId() : cryptoRandomId();
  let res: Response;
  try {
    res = await deps.fetch(`${GRAPH_BASE}/users/${encodeURIComponent(mailbox)}/sendMail`, {
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
    const aliasSuspect = sender.from !== sender.mailbox
      && (res.status === 403 || res.status === 400)
      && /from/i.test(capped);
    const error = aliasSuspect
      ? `Graph sendMail returned ${res.status} sending as alias ${sender.from} through mailbox ${sender.mailbox} — `
        + `check that Exchange has send-from-alias enabled and that ${sender.from} belongs to ${sender.mailbox}: ${capped}`
      : `Graph sendMail returned ${res.status}: ${capped}`;
    return {
      ok: false,
      http_status: res.status,
      body: capped,
      error,
    };
  }

  const graphMessageId = res.headers.get('request-id') ?? clientRequestId;
  // Graph's plain sendMail answers 202 with no body and never a conversationId
  // header — there is nothing to read here today. The column exists so a
  // future switch to a create-then-send flow (which does return one) can
  // populate it without another migration; until then this is always null and
  // the RFQ reply matcher's domain fallback falls back to requiring the
  // [DD-RFQ-…] tag instead (see matchRfqReply).
  const conversationId = res.headers.get('conversation-id');
  const rfqId = resolveRfqId(req.body, req.evidence);
  const sentAt = deps.now();
  const vendorSlug = evidenceVendorSlug(req.evidence);
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
      conversation_id: conversationId,
      vendor_slug: vendorSlug,
      vendor_name: resolveVendorName(req.body, vendorEmail),
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
