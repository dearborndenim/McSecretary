/**
 * Inbox Sweep: pure rules (plan docs/superpowers/plans/2026-11-06-inbox-sweep.md
 * in the claude_code repo, Task 2). No I/O here: the Graph message mapping, the
 * deterministic rules that run before any model call, the lane → action
 * decision, and `unsubscribeEligible`, the only gate in front of the RFC 8058
 * one-click POST.
 *
 * Hard limits (Robert's order OP-20261106-004): never delete; never reply,
 * send or forward; no click except the RFC 8058 POST; never unsubscribe from
 * banks, government, vendors, customers, staff or any real person.
 */

// ---------------------------------------------------------------------------
// Graph message mapping
// ---------------------------------------------------------------------------

export interface SweepHeader {
  name: string;
  value: string;
}

export interface SweepMessage {
  id: string;
  mailbox: string;
  receivedAt: string;
  sender: string;
  senderName: string;
  subject: string;
  to: string[];
  cc: string[];
  bodyPreview: string;
  bodyText: string;
  conversationId: string;
  isRead: boolean;
  hasAttachments: boolean;
  /** `internetMessageHeaders`; null when Graph did not return them. */
  headers: SweepHeader[] | null;
}

function addresses(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list
    .map((r) => (r as { emailAddress?: { address?: unknown } })?.emailAddress?.address)
    .filter((a): a is string => typeof a === 'string' && a.length > 0)
    .map((a) => a.trim().toLowerCase());
}

/** Map one Graph v1.0 message (fields from `SWEEP_MESSAGE_SELECT`) to a `SweepMessage`. */
export function fromGraphMessage(raw: unknown, mailbox: string): SweepMessage {
  const m = raw as Record<string, any>;
  if (!m || typeof m.id !== 'string' || typeof m.receivedDateTime !== 'string') {
    throw new Error('Graph message missing id or receivedDateTime');
  }
  const headers = Array.isArray(m.internetMessageHeaders)
    ? (m.internetMessageHeaders as unknown[])
        .map((h) => h as { name?: unknown; value?: unknown })
        .filter((h) => typeof h.name === 'string' && typeof h.value === 'string')
        .map((h) => ({ name: h.name as string, value: h.value as string }))
    : null;
  return {
    id: m.id,
    mailbox: mailbox.toLowerCase(),
    receivedAt: m.receivedDateTime,
    sender: String(m.from?.emailAddress?.address ?? '').trim().toLowerCase(),
    senderName: String(m.from?.emailAddress?.name ?? ''),
    subject: String(m.subject ?? ''),
    to: addresses(m.toRecipients),
    cc: addresses(m.ccRecipients),
    bodyPreview: String(m.bodyPreview ?? ''),
    bodyText: String(m.body?.content ?? ''),
    conversationId: String(m.conversationId ?? ''),
    isRead: m.isRead === true,
    hasAttachments: m.hasAttachments === true,
    headers,
  };
}

export function domainOf(address: string): string {
  const at = address.lastIndexOf('@');
  return at < 0 ? '' : address.slice(at + 1).trim().toLowerCase();
}

function header(headers: SweepHeader[] | null, name: string): string | null {
  if (!headers) return null;
  const want = name.toLowerCase();
  const hit = headers.find((h) => h.name.toLowerCase() === want);
  return hit ? hit.value : null;
}

// ---------------------------------------------------------------------------
// Folders, lanes, bots
// ---------------------------------------------------------------------------

/** Named folders are created on demand; `archive` / `junkemail` are Graph well-known names. */
export type SweepFolder =
  | 'Promotions'
  | 'DMARC Reports'
  | 'McMillan Manufacturing Reports'
  | 'Gov Bids'
  | 'archive'
  | 'junkemail';

export const SWEEP_LANES = ['promotions', 'junk', 'phishing', 'gov_bid', 'fyi', 'handoff', 'keep'] as const;
export type SweepLane = (typeof SWEEP_LANES)[number];

/** Handoff owners, in the order of rule 7 of the order; `none` = no handoff. */
export const SWEEP_BOTS = [
  'Purchasing Bot',
  'Sourcing Bot',
  'Cliff Claims Bot',
  'Gina',
  'HR Bot',
  'Hiring Bot',
  'ObamaBot',
  'General Paton Bot',
  'Convention Bot',
  'Wholesale Tshirt Bot',
  'Brand Launch Bot',
  'BOAT BOT',
  'OPERATOR',
  'none',
] as const;
export type SweepBot = (typeof SWEEP_BOTS)[number];

/** Below this the classifier's answer is ignored and the message stays in the inbox. */
export const SWEEP_MIN_CONFIDENCE = 0.8;

export interface SweepClassification {
  index: number;
  lane: SweepLane;
  bot: SweepBot;
  key_facts: string;
  urgent_today: boolean;
  confidence: number;
}

// ---------------------------------------------------------------------------
// Deterministic rules (no model call)
// ---------------------------------------------------------------------------

/** Gina's mailbox (purchasing@ is an alias of it). */
export const GINA_ADDRESSES = ['gina@dearborndenim.com', 'purchasing@dearborndenim.com'];

/** Company domains: staff mail is never a vendor reply and never unsubscribed. */
export const COMPANY_DOMAINS = ['dearborndenim.com', 'mcmillan-manufacturing.com'];

export type RuleName = 'rfq_reply' | 'dmarc' | 'mmi_report' | 'gina_copy' | 'gina_thread';

export interface RuleHit {
  rule: RuleName;
  /** null = leave in the inbox. */
  folder: SweepFolder | null;
  /** Ask the classifier as well (a Gina thread: does the reply need action?). */
  classify: boolean;
}

export interface RuleContext {
  /** The message matched an RFQ we sent (`matchRfqReply`). */
  isRfqReply: boolean;
  /** Senders seen at least twice in this mailbox's "McMillan Manufacturing Reports" folder. */
  mmiReportSenders: Set<string>;
  companyDomains: string[];
}

export function isDmarcReport(m: SweepMessage): boolean {
  if (/report domain:/i.test(m.subject)) return true;
  return m.hasAttachments && /dmarc/i.test(m.sender);
}

/**
 * The deterministic rules, first match wins:
 * 1. An RFQ reply stays put: the RFQ intake keys on the Graph message id and a
 *    move re-ids the message, so moving it would make the next Email Scan file
 *    the vendor's quotes (and acknowledgement) a second time.
 * 2. DMARC aggregate reports → DMARC Reports.
 * 3. A sender already filed (twice or more) in McMillan Manufacturing Reports → there.
 * 4. Gina's own copies (from gina@/purchasing@, Rob not in To) → Archive.
 * 5. An outside sender writing to a thread Gina is on → Archive, classified for a handoff.
 */
export function applyDeterministicRules(m: SweepMessage, ctx: RuleContext): RuleHit | null {
  if (ctx.isRfqReply) return { rule: 'rfq_reply', folder: null, classify: false };
  if (isDmarcReport(m)) return { rule: 'dmarc', folder: 'DMARC Reports', classify: false };
  if (m.sender && ctx.mmiReportSenders.has(m.sender)) {
    return { rule: 'mmi_report', folder: 'McMillan Manufacturing Reports', classify: false };
  }
  if (GINA_ADDRESSES.includes(m.sender)) {
    if (!m.to.includes(m.mailbox)) return { rule: 'gina_copy', folder: 'archive', classify: false };
    return null; // Gina writing to Rob directly: classified like any other mail.
  }
  const ginaOnThread = [...m.to, ...m.cc].some((a) => GINA_ADDRESSES.includes(a));
  const external = m.sender !== '' && !ctx.companyDomains.includes(domainOf(m.sender));
  if (ginaOnThread && external) return { rule: 'gina_thread', folder: 'archive', classify: true };
  return null;
}

// ---------------------------------------------------------------------------
// Decision: what to do with one message
// ---------------------------------------------------------------------------

export type TellReason = 'gov_bid' | 'phishing' | 'urgent_today';

export interface SweepDecision {
  /** The lane logged: a rule name or a classifier lane (`keep` when nothing applies). */
  lane: string;
  folder: SweepFolder | null;
  handoffBot: Exclude<SweepBot, 'none'> | null;
  tell: TellReason | null;
  keyFacts: string;
}

function keep(lane: string, c?: SweepClassification): SweepDecision {
  return { lane, folder: null, handoffBot: null, tell: null, keyFacts: c?.key_facts ?? '' };
}

function realBot(bot: SweepBot | undefined): Exclude<SweepBot, 'none'> | null {
  return bot && bot !== 'none' ? bot : null;
}

/**
 * Combine the rule hit (if any) and the classifier's answer (if any). When in
 * doubt the message stays in the inbox: no answer, low confidence, or anything
 * urgent today that is not junk/phishing.
 */
export function decideAction(rule: RuleHit | null, c: SweepClassification | undefined): SweepDecision {
  const confident = c !== undefined && c.confidence >= SWEEP_MIN_CONFIDENCE;

  if (rule && !rule.classify) {
    return { lane: rule.rule, folder: rule.folder, handoffBot: null, tell: null, keyFacts: '' };
  }

  if (rule && rule.classify) {
    // A vendor reply on a Gina thread: Archive (rule 4) unless it is junk, or
    // something Rob must read or decide. Hand it to its owner unless the
    // classifier is confident it needs nothing; an unclassified one goes to Gina.
    if (confident && c.lane === 'phishing') {
      return { lane: 'phishing', folder: 'junkemail', handoffBot: null, tell: 'phishing', keyFacts: c.key_facts };
    }
    if (confident && c.lane === 'junk') return { lane: 'junk', folder: 'junkemail', handoffBot: null, tell: null, keyFacts: c.key_facts };
    if (c?.urgent_today) return { ...keep('gina_thread', c), tell: 'urgent_today' };
    if (confident && c.lane === 'keep') return keep('gina_thread', c); // rule 8: Rob must read or decide it.
    const needsAction = !confident || c.lane === 'handoff' || c.lane === 'gov_bid';
    return {
      lane: rule.rule,
      folder: rule.folder,
      handoffBot: needsAction ? realBot(c?.bot) ?? 'Gina' : null,
      tell: null,
      keyFacts: c?.key_facts ?? '',
    };
  }

  if (!c) return keep('keep');
  if (!confident) return keep('keep', c);
  if (c.lane === 'phishing') {
    return { lane: 'phishing', folder: 'junkemail', handoffBot: null, tell: 'phishing', keyFacts: c.key_facts };
  }
  if (c.lane === 'junk') return { lane: 'junk', folder: 'junkemail', handoffBot: null, tell: null, keyFacts: c.key_facts };
  if (c.urgent_today) return { ...keep(c.lane, c), tell: 'urgent_today' };
  switch (c.lane) {
    case 'promotions':
      return { lane: 'promotions', folder: 'Promotions', handoffBot: null, tell: null, keyFacts: c.key_facts };
    case 'gov_bid':
      return { lane: 'gov_bid', folder: 'Gov Bids', handoffBot: realBot(c.bot), tell: 'gov_bid', keyFacts: c.key_facts };
    case 'fyi':
      return { lane: 'fyi', folder: 'archive', handoffBot: null, tell: null, keyFacts: c.key_facts };
    case 'handoff': {
      const bot = realBot(c.bot);
      if (!bot) return keep('handoff', c); // a handoff with no owner is something we cannot route: rule 8, leave it.
      return { lane: 'handoff', folder: 'archive', handoffBot: bot, tell: null, keyFacts: c.key_facts };
    }
    default:
      return keep('keep', c);
  }
}

// ---------------------------------------------------------------------------
// Unsubscribe gate (RFC 8058 one-click only)
// ---------------------------------------------------------------------------

/** Banks, card networks, payment processors, payroll and accounting: never unsubscribed. */
export const FINANCIAL_DOMAINS = [
  'paypal.com', 'stripe.com', 'squareup.com', 'square.com', 'venmo.com', 'zellepay.com',
  'americanexpress.com', 'aexp.com', 'chase.com', 'jpmorgan.com', 'wellsfargo.com', 'bankofamerica.com',
  'bofa.com', 'citi.com', 'citibank.com', 'capitalone.com', 'discover.com', 'usbank.com', 'pnc.com',
  'wintrust.com', 'fifththird.com', 'bmo.com', 'huntington.com', 'td.com', 'schwab.com', 'fidelity.com',
  'vanguard.com', 'intuit.com', 'quickbooks.com', 'bill.com', 'brex.com', 'ramp.com', 'mercury.com',
  'adp.com', 'gusto.com', 'paychex.com', 'affirm.com', 'klarna.com', 'afterpay.com', 'authorize.net',
  'braintreegateway.com', 'shopify.com', 'shop.app', 'visa.com', 'mastercard.com',
];

function domainIn(domain: string, list: Iterable<string>): boolean {
  for (const d of list) if (domain === d || domain.endsWith(`.${d}`)) return true;
  return false;
}

export function isGovernmentDomain(domain: string): boolean {
  // .gov / .mil (also country forms like .gov.uk) and US locality domains (chicago.il.us).
  return /\.(gov|mil)(\.[a-z]{2})?$/.test(domain) || /\.[a-z]{2}\.us$/.test(domain) || /\.fed\.us$/.test(domain);
}

export function isFinancialDomain(domain: string): boolean {
  if (domainIn(domain, FINANCIAL_DOMAINS)) return true;
  // Any bank or credit union by name (firstbank.com, alliantcreditunion.org, xyzfcu.org).
  return domain.split('.').some((label) => /bank|creditunion|fcu$/.test(label));
}

export interface UnsubscribeInput {
  lane: string;
  sender: string;
  headers: SweepHeader[] | null;
  companyDomains: string[];
  /** Staff addresses (users table) and anything else that must never be unsubscribed. */
  deniedAddresses: Set<string>;
  /** Vendor / customer / correspondent in local records (`isKnownCorrespondent`). */
  knownCorrespondent: boolean;
  /**
   * Rob (or Gina) has engaged with this sender: a Sent Items message to the
   * address or domain, or an earlier message from it marked read. null = the
   * check failed or was not run, which blocks the unsubscribe.
   */
  engaged: boolean | null;
}

export type UnsubscribeVerdict = { ok: true; url: string } | { ok: false; reason: string };

const ONE_CLICK = 'list-unsubscribe=one-click';

/** The https URI of a `List-Unsubscribe` header (`<mailto:…>, <https://…>`), or null. */
export function oneClickUrl(listUnsubscribe: string): URL | null {
  for (const m of listUnsubscribe.matchAll(/<([^>]+)>/g)) {
    let url: URL;
    try { url = new URL(m[1]!.trim()); } catch { continue; }
    if (url.protocol === 'https:') return url;
  }
  return null;
}

function unsafeHost(url: URL): string | null {
  if (url.username || url.password) return 'unsubscribe URL carries credentials';
  if (url.port && url.port !== '443') return 'unsubscribe URL uses a non-standard port';
  const host = url.hostname.toLowerCase();
  if (/^[\d.]+$/.test(host) || host.includes(':') || host.startsWith('[')) return 'unsubscribe URL is an IP address';
  if (!host.includes('.') || /(^|\.)(localhost|local|internal|railway\.internal)$/.test(host)) {
    return 'unsubscribe URL is not a public host';
  }
  return null;
}

/**
 * The only gate in front of an unsubscribe. Eligible only when every check
 * passes: lane `promotions`; RFC 8058 (`List-Unsubscribe-Post:
 * List-Unsubscribe=One-Click` plus an https URI in `List-Unsubscribe`; a
 * mailto-only header or a body link never qualifies); the sender is not
 * government, a bank or payment processor, staff, a company domain or a known
 * correspondent; and Rob has never engaged with it.
 */
export function unsubscribeEligible(i: UnsubscribeInput): UnsubscribeVerdict {
  if (i.lane !== 'promotions') return { ok: false, reason: `lane ${i.lane} is never unsubscribed` };
  const sender = i.sender.trim().toLowerCase();
  const domain = domainOf(sender);
  if (!domain) return { ok: false, reason: 'no sender address' };
  if (isGovernmentDomain(domain)) return { ok: false, reason: 'government sender' };
  if (isFinancialDomain(domain)) return { ok: false, reason: 'bank or payment sender' };
  if (domainIn(domain, i.companyDomains)) return { ok: false, reason: 'company or staff domain' };
  if (i.deniedAddresses.has(sender)) return { ok: false, reason: 'staff address' };
  if (i.knownCorrespondent) return { ok: false, reason: 'known vendor, customer or correspondent' };

  const post = header(i.headers, 'List-Unsubscribe-Post');
  if (!post || post.trim().toLowerCase() !== ONE_CLICK) return { ok: false, reason: 'no RFC 8058 one-click header' };
  const list = header(i.headers, 'List-Unsubscribe');
  const url = list ? oneClickUrl(list) : null;
  if (!url) return { ok: false, reason: 'no https List-Unsubscribe URI (mailto is never used)' };
  const unsafe = unsafeHost(url);
  if (unsafe) return { ok: false, reason: unsafe };

  if (i.engaged === null) return { ok: false, reason: 'engagement check did not complete' };
  if (i.engaged) return { ok: false, reason: 'Rob has engaged with this sender' };
  return { ok: true, url: url.href };
}

// ---------------------------------------------------------------------------
// Mode
// ---------------------------------------------------------------------------

export type SweepMode = 'off' | 'shadow' | 'live';

/** `INBOX_SWEEP_MODE`: anything other than `shadow` or `live` is off. */
export function parseSweepMode(value: string | undefined): SweepMode {
  const v = (value ?? '').trim().toLowerCase();
  return v === 'shadow' || v === 'live' ? v : 'off';
}
