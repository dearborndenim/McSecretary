/**
 * RFQ reply intake (spec §12.3).
 *
 * The Sourcing agent mails vendors through the built-in `email` hand; every
 * send lands a row in `rfq_messages`. When a vendor answers, the triage
 * pipeline recognises the reply — by the `[DD-RFQ-<id>]` tag the outbound
 * subject carries, or by the sender's domain matching a vendor we mailed
 * inside the last 60 days — and, instead of the ordinary Haiku classifier,
 * runs an extraction prompt over it. Each option block the vendor filled in
 * becomes a product-dev vendor quote; the swatch/spec-sheet attachments are
 * saved somewhere the gallery can load them; a reply nothing could be pulled
 * out of becomes a `notes` card for Robert. Either way McSecretary emits
 * `vendor_quote_received` (urgent) so Sourcing wakes on the chain.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type Database from 'better-sqlite3';
import {
  emailDomain, findRfqMessageByDomain, findRfqMessageByRfqId, parseIntents,
  isRfqReplyProcessed, markRfqReplyProcessed, type RfqMessageRow,
} from '../db/rfq-queries.js';
import { mailboxAddress, fromAddress } from '../spine/email-hand.js';
import type { ProposalInput, SpineEventInput } from '../spine/types.js';
import type { Routed } from '../spine/router.js';
import type { ClassifiedEmail, RawEmail } from './types.js';

/** A vendor whose reply arrives more than this long after our RFQ is not a reply to it. */
export const RFQ_MATCH_WINDOW_DAYS = 60;

/** The subject tag the outbound RFQ carries: `[DD-RFQ-<rfq_id>]`. */
export const RFQ_TAG_RE = /\[DD-RFQ-([A-Za-z0-9][A-Za-z0-9._+-]{0,127})\]/;

/** Sanity caps so one chatty vendor cannot file a hundred quotes. */
export const MAX_OPTIONS = 10;
export const MAX_INTENTS = 5;
export const MAX_QUOTES = 20;
export const MAX_ATTACHMENTS = 8;

export function extractRfqTag(...texts: (string | null | undefined)[]): string | null {
  for (const t of texts) {
    if (!t) continue;
    const m = RFQ_TAG_RE.exec(t);
    if (m) return m[1]!;
  }
  return null;
}

export interface RfqMatch {
  /** The matched `rfq_messages` row id — the outbound send the acknowledgement gets recorded against. */
  id: number;
  rfq_id: string;
  vendor_email: string;
  vendor_domain: string;
  intents: string[];
  proposal_id: number | null;
  brand_id: string;
  matched_by: 'tag' | 'domain';
}

function toMatch(row: RfqMessageRow, matchedBy: 'tag' | 'domain'): RfqMatch {
  return {
    id: row.id,
    rfq_id: row.rfq_id,
    vendor_email: row.vendor_email,
    vendor_domain: row.vendor_domain,
    intents: parseIntents(row.intents),
    proposal_id: row.proposal_id ?? null,
    brand_id: row.brand_id || '',
    matched_by: matchedBy,
  };
}

/** `RFQ_OWN_DOMAINS` env default — the mailbox that sends RFQs and receives Robert's self-tests. */
const DEFAULT_OWN_DOMAINS = 'dearborndenim.com';

/**
 * Domains that must never be treated as a vendor by the domain fallback: the
 * RFQ-sending mailbox/alias, plus whatever `RFQ_OWN_DOMAINS` names (CSV,
 * default `dearborndenim.com`). Robert's self-tests send an RFQ to his own
 * mailbox, which otherwise leaves a `rfq_messages` row whose vendor_domain is
 * our own domain — every other internal email from that domain would then
 * false-match as a reply to it.
 */
export function resolveOwnDomains(env: Record<string, string | undefined>): string[] {
  const domains = new Set<string>();
  const mailboxDomain = emailDomain(mailboxAddress(env));
  if (mailboxDomain) domains.add(mailboxDomain);
  const fromDomain = emailDomain(fromAddress(env));
  if (fromDomain) domains.add(fromDomain);
  for (const part of (env.RFQ_OWN_DOMAINS ?? DEFAULT_OWN_DOMAINS).split(',')) {
    const d = part.trim().toLowerCase();
    if (d) domains.add(d);
  }
  return [...domains];
}

/**
 * Is this inbound message a reply to one of our RFQs? The tag wins (it names
 * the exact RFQ even when the vendor mails from a different address).
 *
 * The domain fallback is for vendors whose mail client strips the subject —
 * but a bare domain match is not enough on its own (spec fix, 2026-09):
 *   - the sender's domain must not be one of `ownDomains` (a self-test RFQ,
 *     sent to our own mailbox, must never let *other* internal mail from that
 *     domain false-match as a vendor reply);
 *   - and, when the sender's domain differs from ours, the fallback still only
 *     fires when the inbound message either carries the `[DD-RFQ-…]` tag (even
 *     if it didn't resolve a specific row above) or landed in the same Graph
 *     conversation as the RFQ we sent.
 */
export function matchRfqReply(
  db: Database.Database,
  email: RawEmail,
  nowIso: string,
  opts: { ownDomains?: string[] } = {},
): RfqMatch | null {
  const tag = extractRfqTag(email.subject, email.bodyPreview);
  if (tag) {
    const row = findRfqMessageByRfqId(db, tag);
    if (row) return toMatch(row, 'tag');
  }
  const domain = emailDomain(email.sender);
  if (!domain) return null;
  const ownDomains = opts.ownDomains ?? [];
  if (ownDomains.includes(domain)) return null;
  if (!tag && !email.threadId) return null;
  const since = new Date(new Date(nowIso).getTime() - RFQ_MATCH_WINDOW_DAYS * 86_400_000).toISOString();
  const row = findRfqMessageByDomain(db, domain, since);
  if (!row) return null;
  if (tag) return toMatch(row, 'domain');
  if (row.conversation_id && row.conversation_id === email.threadId) return toMatch(row, 'domain');
  return null;
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

const nullableNumber = (description: string) => ({
  anyOf: [{ type: 'number' }, { type: 'null' }],
  description,
});
const nullableString = (description: string) => ({
  anyOf: [{ type: 'string' }, { type: 'null' }],
  description,
});

/**
 * Strict JSON for the vendor's option blocks. Keyword subset only — the live
 * structured-outputs endpoint rejects minimum/maximum/oneOf and enum unions
 * (tests/email/output-schemas-guard.test.ts walks this).
 */
export const RFQ_EXTRACTION_OUTPUT_FORMAT: Anthropic.Messages.JSONOutputFormat = {
  type: 'json_schema',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['options', 'unparsed_excerpt'],
    properties: {
      options: {
        type: 'array',
        description: 'One entry per fabric the vendor offered. Empty when the reply quotes no fabric.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'style_number', 'price_per_yard_usd', 'weight_oz', 'width_in',
            'content', 'moq', 'moq_unit', 'lead_days', 'notes',
          ],
          properties: {
            style_number: { type: 'string', description: "The vendor's style or article number, verbatim." },
            price_per_yard_usd: nullableNumber('Price per yard in US dollars, null if not quoted.'),
            weight_oz: nullableNumber('Fabric weight in ounces per square yard, null if not stated.'),
            width_in: nullableNumber('Usable roll width in inches, null if not stated.'),
            content: nullableString('Fiber content as written, e.g. "100% linen".'),
            moq: nullableNumber('Minimum order quantity as a number, null if not stated.'),
            moq_unit: nullableString('Unit of the minimum, e.g. "yards" or "meters".'),
            lead_days: nullableNumber('Lead time in days, null if not stated.'),
            notes: nullableString('Anything else about this option worth keeping, one sentence.'),
          },
        },
      },
      unparsed_excerpt: {
        type: 'string',
        description: 'Up to 600 chars of the reply that could not be turned into options. Empty when everything parsed.',
      },
    },
  },
};

export const RFQ_EXTRACTION_SYSTEM_PROMPT = `You read vendor replies to fabric requests for Dearborn Denim and pull out the fabric options they offered.

Rules:
- One entry per distinct fabric. A vendor who lists three articles gives three options.
- Copy numbers as the vendor wrote them; convert a price like "$6.75/yd" to 6.75. Convert prices per meter to per yard only if the vendor labelled them per meter (divide by 1.0936).
- Never invent a value. Anything the vendor did not state is null.
- style_number is required; when the vendor names a fabric but gives no article number, use the fabric name.
- Put anything you could not turn into an option — questions, terms, a refusal, a price list you could not read — into unparsed_excerpt verbatim (up to 600 chars).
- A reply that quotes nothing (an out-of-office, an acknowledgement, a request for more detail) has an empty options array and the reply in unparsed_excerpt.`;

export function buildExtractionPrompt(email: RawEmail): string {
  return `Vendor reply to a Dearborn Denim fabric request.

From: ${email.senderName} <${email.sender}>
Subject: ${email.subject}
Date: ${email.receivedAt}

Body:
${email.body}`;
}

export interface RfqOption {
  style_number: string;
  price_per_yard_usd: number | null;
  weight_oz: number | null;
  width_in: number | null;
  content: string | null;
  moq: number | null;
  moq_unit: string | null;
  lead_days: number | null;
  notes: string | null;
}

export interface RfqExtraction {
  options: RfqOption[];
  unparsed_excerpt: string;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

/**
 * Boundary check on the model's answer. The schema already guarantees the
 * shape; this rejects anything that slipped through and drops option blocks
 * with no style number (nothing downstream can name them).
 */
export function parseRfqExtraction(raw: string): RfqExtraction {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('RFQ extraction: response is not an object');
  }
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.options)) throw new Error('RFQ extraction: options is not an array');
  const options: RfqOption[] = [];
  for (const row of obj.options.slice(0, MAX_OPTIONS)) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const r = row as Record<string, unknown>;
    const style = str(r.style_number);
    if (!style) continue;
    options.push({
      style_number: style,
      price_per_yard_usd: num(r.price_per_yard_usd),
      weight_oz: num(r.weight_oz),
      width_in: num(r.width_in),
      content: str(r.content),
      moq: num(r.moq),
      moq_unit: str(r.moq_unit),
      lead_days: num(r.lead_days),
      notes: str(r.notes),
    });
  }
  const excerpt = typeof obj.unparsed_excerpt === 'string' ? obj.unparsed_excerpt : '';
  return { options, unparsed_excerpt: excerpt.slice(0, 600) };
}

// ---------------------------------------------------------------------------
// Filing
// ---------------------------------------------------------------------------

export interface QuoteAttachment {
  url: string;
  name: string;
  kind: 'image' | 'pdf' | 'file';
}

export interface VendorQuoteBody {
  fabricIntentId: string;
  vendorName: string;
  description: string;
  pricePerUnit: number | null;
  unit: 'yard';
  moq: number | null;
  leadDays: number | null;
  priceStatus: 'quoted';
  rfqId: string;
  styleNumber: string;
  widthIn: number | null;
  weightOz: number | null;
  attachments: QuoteAttachment[];
}

/** The product-dev `POST /api/integration/vendor-quotes` body for one option on one intent. */
export function buildVendorQuoteBody(
  option: RfqOption,
  ctx: { fabricIntentId: string; vendorName: string; rfqId: string; attachments: QuoteAttachment[] },
): VendorQuoteBody {
  return {
    fabricIntentId: ctx.fabricIntentId,
    vendorName: ctx.vendorName,
    description: `${option.style_number} — ${ctx.vendorName}`,
    pricePerUnit: option.price_per_yard_usd,
    unit: 'yard',
    moq: option.moq,
    leadDays: option.lead_days,
    priceStatus: 'quoted',
    rfqId: ctx.rfqId,
    styleNumber: option.style_number,
    widthIn: option.width_in,
    weightOz: option.weight_oz,
    attachments: ctx.attachments,
  };
}

/** The vendor's display name: what they signed the mail as, else their domain. */
export function vendorNameFor(email: RawEmail, match: RfqMatch): string {
  const name = email.senderName?.trim();
  if (name && !name.includes('@')) return name;
  return match.vendor_domain || emailDomain(email.sender) || email.sender;
}

export interface RfqIntakeDeps {
  db: Database.Database;
  now: () => string;
  /** Brand the quotes and the card belong to. */
  brandId: string;
  extract: (email: RawEmail) => Promise<RfqExtraction>;
  saveAttachments: (email: RawEmail, rfqId: string) => Promise<QuoteAttachment[]>;
  postVendorQuote: (body: VendorQuoteBody) => Promise<{ ok: boolean; id: string | null; error?: string }>;
  file: (input: ProposalInput) => Promise<{ id: number; routed: Routed }>;
  emitEvent: (e: SpineEventInput) => void;
  /**
   * Sends the one-line acknowledgement in the vendor's thread. Called only
   * after >=1 quote has been filed (never for an unparsed reply); idempotent
   * on the inbound message id, so a re-triage is safe to call again.
   */
  sendAcknowledgement: (email: RawEmail, match: RfqMatch) => Promise<{ ok: boolean; error?: string }>;
  /** How long the unparsed-reply card stays actionable. Default 48 h. */
  expiryHours?: number;
}

export interface RfqIntakeResult {
  rfq_id: string;
  vendor: string;
  options: number;
  /** Ids product-dev handed back. A 2xx with no id still counts in `filed`. */
  quotes: string[];
  filed: number;
  intents: string[];
  noted: boolean;
  summary: string;
  suggestedAction: string;
  errors: string[];
}

const NOTE_TITLE_MAX = 120;
const NOTE_SUMMARY_MAX = 2000;

/**
 * Turn one recognised vendor reply into product-dev vendor quotes.
 *
 * The RFQ that produced the reply may have bundled several fabric intents into
 * one mail (spec §12.1), and a vendor answering "here are fabrics that could
 * work" does not say which of our fabrics each article is for. So every option
 * is filed against every intent on the RFQ — Sourcing ranks per intent (§12.5)
 * and Robert picks one — capped at MAX_QUOTES rows so a long price list cannot
 * flood product-dev.
 */
export async function processRfqReply(
  email: RawEmail,
  match: RfqMatch,
  deps: RfqIntakeDeps,
): Promise<RfqIntakeResult> {
  const vendor = vendorNameFor(email, match);
  const errors: string[] = [];

  let extraction: RfqExtraction;
  try {
    extraction = await deps.extract(email);
  } catch (err) {
    extraction = { options: [], unparsed_excerpt: `Extraction failed: ${err instanceof Error ? err.message : String(err)}` };
    errors.push(extraction.unparsed_excerpt);
  }

  let attachments: QuoteAttachment[] = [];
  try {
    attachments = (await deps.saveAttachments(email, match.rfq_id)).slice(0, MAX_ATTACHMENTS);
  } catch (err) {
    errors.push(`Attachment save failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const intents = match.intents.slice(0, MAX_INTENTS);
  const quotes: string[] = [];
  let filed = 0;

  if (extraction.options.length > 0 && intents.length > 0) {
    outer: for (const intentId of intents) {
      for (const option of extraction.options) {
        if (filed >= MAX_QUOTES) break outer;
        const body = buildVendorQuoteBody(option, {
          fabricIntentId: intentId,
          vendorName: vendor,
          rfqId: match.rfq_id,
          attachments,
        });
        try {
          const posted = await deps.postVendorQuote(body);
          if (posted.ok) {
            filed += 1;
            if (posted.id) quotes.push(posted.id);
          } else {
            errors.push(`Quote ${option.style_number} → intent ${intentId} rejected: ${posted.error ?? 'unknown error'}`);
          }
        } catch (err) {
          errors.push(`Quote ${option.style_number} → intent ${intentId} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }

  let noted = false;
  if (extraction.options.length === 0 || intents.length === 0 || filed === 0) {
    const why = extraction.options.length === 0
      ? 'no fabric options could be read out of it'
      : intents.length === 0
        ? 'the RFQ carried no fabric intents to file them against'
        : 'every quote was rejected by product-dev';
    const excerpt = extraction.unparsed_excerpt || email.bodyPreview || email.body.slice(0, 600);
    const summaryText = [
      `${vendor} replied to RFQ ${match.rfq_id || '(untagged)'} and ${why}.`,
      extraction.options.length > 0 ? `${extraction.options.length} option(s) read.` : '',
      excerpt ? `\n\n"${excerpt.slice(0, 1200)}"` : '',
      errors.length > 0 ? `\n\nErrors: ${errors.join('; ')}` : '',
    ].filter(Boolean).join(' ').slice(0, NOTE_SUMMARY_MAX);
    const now = new Date(deps.now());
    try {
      await deps.file({
        agent: 'mcsecretary',
        brand_id: match.brand_id || deps.brandId,
        action_type: 'rfq_reply_unparsed',
        action_payload: {
          hand: 'notes',
          method: 'POST',
          path: '/note',
          body: {
            title: `RFQ reply needs a human — ${vendor}`.slice(0, NOTE_TITLE_MAX),
            summary: summaryText,
            notify: `RFQ ${match.rfq_id || '(untagged)'}: ${vendor} replied but ${why}.`.slice(0, 600),
            details: {
              rfq_id: match.rfq_id,
              vendor,
              from: email.sender,
              subject: email.subject,
              message_id: email.id,
              options_read: extraction.options.length,
              intents: match.intents,
              attachments: attachments.map((a) => a.url),
            },
          },
        },
        reason: `Vendor reply to RFQ ${match.rfq_id || '(untagged)'} produced no filed quotes.`,
        evidence: {
          rfq_id: match.rfq_id,
          vendor,
          from: email.sender,
          subject: email.subject.slice(0, 200),
          matched_by: match.matched_by,
        },
        cost_usd: 0,
        reversible: true,
        level_required: 1,
        expires_at: new Date(now.getTime() + (deps.expiryHours ?? 48) * 3_600_000).toISOString(),
      });
      noted = true;
    } catch (err) {
      errors.push(`Notes card failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (filed > 0) {
    try {
      deps.emitEvent({
        source_hand: 'mcsecretary',
        brand_id: match.brand_id || deps.brandId,
        event_type: 'vendor_quote_received',
        payload: { rfq_id: match.rfq_id, vendor, quotes, intents },
        urgent: true,
      });
    } catch (err) {
      errors.push(`Event emit failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Never acknowledge a reply that yielded no filed quotes (unparsed, no intents, all rejected).
    try {
      const ack = await deps.sendAcknowledgement(email, match);
      if (!ack.ok) errors.push(`Acknowledgement failed: ${ack.error ?? 'unknown error'}`);
    } catch (err) {
      errors.push(`Acknowledgement failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const summary = filed > 0
    ? `${vendor} answered RFQ ${match.rfq_id || '(untagged)'} with ${extraction.options.length} fabric option(s); ${filed} quote(s) filed on ${intents.length} intent(s).`
    : `${vendor} replied to RFQ ${match.rfq_id || '(untagged)'} but no quote could be filed${noted ? ' — carded for review' : ''}.`;

  return {
    rfq_id: match.rfq_id,
    vendor,
    options: extraction.options.length,
    quotes,
    filed,
    intents,
    noted,
    summary,
    suggestedAction: filed > 0
      ? 'Sourcing will rank the options; pick one in the gallery.'
      : 'Read the reply and answer the vendor.',
    errors,
  };
}

export type RfqIntakeHandler = (email: RawEmail, match: RfqMatch) => Promise<RfqIntakeResult>;

/**
 * Run the RFQ intake for a recognised vendor reply and return it as a
 * `ClassifiedEmail` so the rest of the loop (sender profile, Outlook action,
 * processed-email row, briefing) is unchanged. Category is `rfq_reply`; a
 * failed intake still yields a row, flagged for Robert, with the error in the
 * summary — the reply must never vanish because product-dev was down.
 */
interface RfqReplyProcessing {
  classified: ClassifiedEmail;
  /** null when the handler itself threw — a wiring failure, not an intake outcome. */
  result: RfqIntakeResult | null;
}

/**
 * Run a matched reply through the intake handler and build the `ClassifiedEmail`
 * both call sites need, without deciding anything about idempotency — that is
 * `intakeRfqRepliesFrom`'s job (§ below). `classifyRfqReply` is this with only
 * the classified row kept, for triage's inline per-email loop; `errors` is
 * appended to in place either way.
 */
async function runRfqIntakeForEmail(
  email: RawEmail,
  match: RfqMatch,
  intake: RfqIntakeHandler,
  errors: string[],
): Promise<RfqReplyProcessing> {
  const base = {
    ...email,
    category: 'rfq_reply',
    urgency: 'high',
    actionNeeded: 'review_required',
    confidence: 1,
    senderImportance: 'vendor',
  };
  try {
    const result = await intake(email, match);
    for (const e of result.errors) errors.push(`RFQ ${result.rfq_id || '(untagged)'}: ${e}`);
    return { classified: { ...base, summary: result.summary, suggestedAction: result.suggestedAction }, result };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`RFQ intake failed for ${email.id}: ${msg}`);
    return {
      classified: {
        ...base,
        summary: `Vendor reply to RFQ ${match.rfq_id || '(untagged)'} could not be processed: ${msg}`,
        suggestedAction: 'Read the reply and file the quotes by hand.',
      },
      result: null,
    };
  }
}

export async function classifyRfqReply(
  email: RawEmail,
  match: RfqMatch,
  intake: RfqIntakeHandler,
  errors: string[],
): Promise<ClassifiedEmail> {
  return (await runRfqIntakeForEmail(email, match, intake, errors)).classified;
}

// ---------------------------------------------------------------------------
// Shared scan/triage entry point (idempotent across the 30-min Email Scan,
// the 5 AM triage, and the "scan rfq" Telegram command)
// ---------------------------------------------------------------------------

export interface RfqReplyOutcome {
  match: RfqMatch;
  /** True when a *previous* scan/triage already ran this inbound message through intake. */
  skipped: boolean;
  classified: ClassifiedEmail;
  /** The intake result, when the handler ran and resolved this time. Null when skipped or the handler threw. */
  result: RfqIntakeResult | null;
}

export interface RfqScanDeps {
  db: Database.Database;
  now: () => string;
  handler: RfqIntakeHandler;
  /** Source for RFQ_MAILBOX / RFQ_FROM_ADDRESS / RFQ_OWN_DOMAINS (own-domain gate on the matcher's domain fallback). Defaults to `{}` (dearborndenim.com). */
  env?: Record<string, string | undefined>;
}

export interface RfqScanSummary {
  /** Messages handed in. */
  scanned: number;
  /** Recognised as a reply to one of our RFQs. */
  matched: number;
  /** Matched but already processed by an earlier scan/triage — no-op this time. */
  skipped: number;
  /** Vendor quotes filed across every matched, newly-processed reply. */
  filed: number;
  /** Replies that produced a `rfq_reply_unparsed` notes card. */
  noted: number;
  errors: string[];
  /** Per-message-id outcome, for a caller (triage) that needs the classified row back. */
  outcomes: Map<string, RfqReplyOutcome>;
}

/**
 * Run the RFQ reply matcher over a batch of inbound messages and, for each
 * match not already processed, run the registered intake handler exactly
 * once — recording it in `rfq_replies` so a later scan/triage over the same
 * inbound message id is a no-op. Used by both `runTriage` (spec §12.3) and
 * the 30-minute Email Scan job / the "scan rfq" command (a vendor reply must
 * not wait up to a day for the next briefing to notice it).
 */
export async function intakeRfqRepliesFrom(
  messages: RawEmail[],
  deps: RfqScanDeps,
): Promise<RfqScanSummary> {
  const summary: RfqScanSummary = {
    scanned: messages.length, matched: 0, skipped: 0, filed: 0, noted: 0, errors: [], outcomes: new Map(),
  };
  const ownDomains = resolveOwnDomains(deps.env ?? {});
  for (const email of messages) {
    try {
      const match = matchRfqReply(deps.db, email, deps.now(), { ownDomains });
      if (!match) continue;
      summary.matched += 1;

      if (isRfqReplyProcessed(deps.db, email.id)) {
        summary.skipped += 1;
        summary.outcomes.set(email.id, {
          match,
          skipped: true,
          result: null,
          classified: {
            ...email,
            category: 'rfq_reply',
            urgency: 'high',
            actionNeeded: 'review_required',
            confidence: 1,
            senderImportance: 'vendor',
            summary: `Vendor reply to RFQ ${match.rfq_id || '(untagged)'} already processed by an earlier scan.`,
            suggestedAction: 'No action needed — already filed.',
          },
        });
        continue;
      }

      const { classified, result } = await runRfqIntakeForEmail(email, match, deps.handler, summary.errors);
      if (result) {
        // Only mark processed when the handler actually resolved. A thrown
        // error is a wiring failure (deps misconfigured, db locked) — the
        // next scan should retry it, not skip it forever.
        markRfqReplyProcessed(deps.db, email.id, match.rfq_id, deps.now());
        summary.filed += result.filed;
        if (result.noted) summary.noted += 1;
      }
      summary.outcomes.set(email.id, { match, skipped: false, classified, result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      summary.errors.push(`RFQ matching failed for ${email.id}: ${msg}`);
    }
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Runtime registration (wired in src/index.ts, read by src/triage.ts)
// ---------------------------------------------------------------------------

let _handler: RfqIntakeHandler | null = null;

/**
 * Registered from `src/index.ts` once the spine exists. Triage stays a pure
 * consumer: with no handler registered (tests, the admin CLI) an RFQ reply is
 * classified by the ordinary path and nothing is filed.
 */
export function setRfqIntakeHandler(handler: RfqIntakeHandler | null): void {
  _handler = handler;
}

export function getRfqIntakeHandler(): RfqIntakeHandler | null {
  return _handler;
}
