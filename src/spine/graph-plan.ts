/**
 * The chat → agent-graph dispatch plan (spec §1.2).
 *
 * Pure: no DB, no network, no clock of its own — the caller passes `nowIso`.
 * Imported by the chat tool that drafts the plan, by the built-in `graph` hand
 * that turns an approved plan into spine events, and by the Telegram card that
 * renders it for Robert. One validator, so all three agree on what a plan is.
 */

export type BriefLine = 'mens' | 'womens';
export type DyeProgram = 'pfd_house_dye' | 'vendor_dyed';
/** The real ladder (product-dev `PRICE_TIERS`); there is no "luxury" tier. */
export type PriceTier = 'value' | 'core' | 'premium';

export interface DispatchBrief {
  collection_name: string;
  line: BriefLine;
  brief_text: string;
  season: string;
  /** YYYY-MM-DD */
  target_launch: string;
  product_count: number | null;
  price_ladder: PriceTier[] | null;
  fabric_locks: string[] | null;
  vendor: string | null;
  dye_program: DyeProgram | null;
  /** "all" fans the brief out over every approved persona of that line. */
  persona: string;
}

export interface DispatchVendorContact {
  vendor_name: string;
  slug: string | null;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  sells: string[] | null;
  notes: string | null;
}

export interface DispatchRunRequest {
  agent: string;
  reason: string;
}

export interface DispatchPlan {
  summary: string;
  briefs: DispatchBrief[];
  vendor_contacts: DispatchVendorContact[];
  run_requests: DispatchRunRequest[];
}

export type DispatchPlanResult =
  | { ok: true; plan: DispatchPlan }
  | { ok: false; error: string };

export const MIN_BRIEF_TEXT = 40;
export const MAX_PRODUCT_COUNT = 8;
/** Bounds, so one chat message can never file a card the phone cannot show. */
export const MAX_BRIEFS = 12;
export const MAX_VENDOR_CONTACTS = 10;
export const MAX_RUN_REQUESTS = 5;
export const MAX_FABRIC_LOCKS = 12;
export const MAX_SELLS = 20;
export const PRICE_TIERS: readonly PriceTier[] = Object.freeze(['value', 'core', 'premium'] as const);
export const DYE_PROGRAMS: readonly DyeProgram[] = Object.freeze(['pfd_house_dye', 'vendor_dyed'] as const);

const SUMMARY_MAX = 200;
const NAME_MAX = 120;
const REASON_MAX = 300;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LAUNCH_LEAD_DAYS = 56;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function trimmedString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length === 0 ? null : t;
}

/** The season that starts after `nowIso` — shown on the card so Robert can veto it. */
export function defaultSeason(nowIso: string): string {
  const d = new Date(nowIso);
  const m = d.getUTCMonth();
  const y = d.getUTCFullYear();
  if (m <= 1) return `Spring ${y}`;
  if (m <= 4) return `Summer ${y}`;
  if (m <= 7) return `Fall ${y}`;
  if (m <= 9) return `Winter ${y}`;
  return `Spring ${y + 1}`;
}

/** Eight weeks out, date only. */
export function defaultTargetLaunch(nowIso: string): string {
  return new Date(Date.parse(nowIso) + LAUNCH_LEAD_DAYS * 86_400_000).toISOString().slice(0, 10);
}

function validateBrief(raw: unknown, i: number, nowIso: string):
  | { ok: true; briefs: DispatchBrief[] }
  | { ok: false; error: string } {
  const where = `brief ${i + 1}`;
  if (!isPlainObject(raw)) return { ok: false, error: `briefs[${i}] must be an object` };

  if (Object.hasOwn(raw, 'fabric_catalog')) {
    return {
      ok: false,
      error: `fabric_catalog is never set from chat (${where}); the Designer treats a missing catalog file as a contract violation`,
    };
  }

  const collection_name = trimmedString(raw.collection_name);
  if (!collection_name || collection_name.length > NAME_MAX) {
    return { ok: false, error: `collection_name must be a non-empty string of at most ${NAME_MAX} chars (${where})` };
  }

  const brief_text = trimmedString(raw.brief_text);
  if (!brief_text || brief_text.length < MIN_BRIEF_TEXT) {
    return { ok: false, error: `brief_text must be at least ${MIN_BRIEF_TEXT} characters (${where})` };
  }

  let lines: BriefLine[];
  const rawLine = raw.line === undefined || raw.line === null ? 'both' : raw.line;
  if (rawLine === 'both') lines = ['mens', 'womens'];
  else if (rawLine === 'mens' || rawLine === 'womens') lines = [rawLine];
  else return { ok: false, error: `line must be mens, womens or both (${where})` };

  const season = trimmedString(raw.season) ?? defaultSeason(nowIso);

  let target_launch: string;
  if (raw.target_launch === undefined || raw.target_launch === null) {
    target_launch = defaultTargetLaunch(nowIso);
  } else {
    const t = typeof raw.target_launch === 'string' ? raw.target_launch.trim() : '';
    if (!DATE_RE.test(t) || Number.isNaN(Date.parse(t))) {
      return { ok: false, error: `target_launch must be YYYY-MM-DD (${where})` };
    }
    target_launch = t;
  }

  let product_count: number | null = null;
  if (raw.product_count !== undefined && raw.product_count !== null) {
    const n = raw.product_count;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > MAX_PRODUCT_COUNT) {
      return { ok: false, error: `product_count must be an integer 1..${MAX_PRODUCT_COUNT} (${where})` };
    }
    product_count = n;
  }

  let price_ladder: PriceTier[] | null = null;
  if (raw.price_ladder !== undefined && raw.price_ladder !== null) {
    const v = raw.price_ladder;
    if (!Array.isArray(v) || v.length === 0 || !v.every((t) => PRICE_TIERS.includes(t as PriceTier))) {
      return { ok: false, error: `price_ladder must be a non-empty array of ${PRICE_TIERS.join('/')} (${where})` };
    }
    price_ladder = PRICE_TIERS.filter((t) => v.includes(t));
  }

  let fabric_locks: string[] | null = null;
  if (raw.fabric_locks !== undefined && raw.fabric_locks !== null) {
    const v = raw.fabric_locks;
    if (!Array.isArray(v)) return { ok: false, error: `fabric_locks must be an array of strings (${where})` };
    if (v.length > MAX_FABRIC_LOCKS) {
      return { ok: false, error: `fabric_locks holds at most ${MAX_FABRIC_LOCKS} entries (${where})` };
    }
    const cleaned = v.map(trimmedString);
    if (cleaned.some((s) => s === null)) {
      return { ok: false, error: `fabric_locks must be an array of non-empty strings (${where})` };
    }
    fabric_locks = cleaned as string[];
  }

  let vendor: string | null = null;
  if (raw.vendor !== undefined && raw.vendor !== null) {
    const v = trimmedString(raw.vendor);
    if (!v || v.length > NAME_MAX) {
      return { ok: false, error: `vendor must be a non-empty string of at most ${NAME_MAX} chars (${where})` };
    }
    vendor = v;
  }

  let dye_program: DyeProgram | null = null;
  if (raw.dye_program !== undefined && raw.dye_program !== null) {
    if (!DYE_PROGRAMS.includes(raw.dye_program as DyeProgram)) {
      return { ok: false, error: `dye_program must be one of ${DYE_PROGRAMS.join('/')} (${where})` };
    }
    dye_program = raw.dye_program as DyeProgram;
  }

  const personaRaw = trimmedString(raw.persona);
  if (personaRaw && personaRaw.length > NAME_MAX) {
    return { ok: false, error: `persona must be at most ${NAME_MAX} chars (${where})` };
  }
  const persona = personaRaw ?? 'all';

  return {
    ok: true,
    briefs: lines.map((line) => ({
      collection_name, line, brief_text, season, target_launch,
      product_count, price_ladder: price_ladder ? [...price_ladder] : null,
      fabric_locks: fabric_locks ? [...fabric_locks] : null,
      vendor, dye_program, persona,
    })),
  };
}

function validateVendorContact(raw: unknown, i: number):
  | { ok: true; contact: DispatchVendorContact }
  | { ok: false; error: string } {
  if (!isPlainObject(raw)) return { ok: false, error: `vendor_contacts[${i}] must be an object` };
  const vendor_name = trimmedString(raw.vendor_name);
  if (!vendor_name || vendor_name.length > NAME_MAX) {
    return { ok: false, error: `vendor_contacts[${i}].vendor_name must be a non-empty string of at most ${NAME_MAX} chars` };
  }
  let email: string | null = null;
  if (raw.email !== undefined && raw.email !== null && raw.email !== '') {
    const e = trimmedString(raw.email);
    if (!e || !EMAIL_RE.test(e)) {
      return { ok: false, error: `vendor_contacts[${i}].email does not look like an email address` };
    }
    email = e;
  }
  let sells: string[] | null = null;
  if (raw.sells !== undefined && raw.sells !== null) {
    if (!Array.isArray(raw.sells)) return { ok: false, error: `vendor_contacts[${i}].sells must be an array of strings` };
    if (raw.sells.length > MAX_SELLS) {
      return { ok: false, error: `vendor_contacts[${i}].sells holds at most ${MAX_SELLS} entries` };
    }
    const cleaned = raw.sells.map(trimmedString);
    if (cleaned.some((s) => s === null)) {
      return { ok: false, error: `vendor_contacts[${i}].sells must be an array of non-empty strings` };
    }
    sells = cleaned as string[];
  }
  return {
    ok: true,
    contact: {
      vendor_name,
      slug: trimmedString(raw.slug),
      contact_name: trimmedString(raw.contact_name),
      email,
      phone: trimmedString(raw.phone),
      sells,
      notes: trimmedString(raw.notes),
    },
  };
}

function validateRunRequest(raw: unknown, i: number):
  | { ok: true; request: DispatchRunRequest }
  | { ok: false; error: string } {
  if (!isPlainObject(raw)) return { ok: false, error: `run_requests[${i}] must be an object` };
  const agent = trimmedString(raw.agent);
  if (!agent || agent.length > NAME_MAX) {
    return { ok: false, error: `run_requests[${i}].agent must be a non-empty agent name` };
  }
  const reason = trimmedString(raw.reason);
  if (!reason || reason.length > REASON_MAX) {
    return { ok: false, error: `run_requests[${i}].reason must be a non-empty string of at most ${REASON_MAX} chars` };
  }
  return { ok: true, request: { agent, reason } };
}

function listOf(raw: unknown, key: string): { ok: true; items: unknown[] } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, items: [] };
  if (!Array.isArray(raw)) return { ok: false, error: `${key} must be an array` };
  return { ok: true, items: raw };
}

/**
 * `run-designers.sh` suffixes the persona name onto `collection_name` to build
 * the design-module slug — two briefs with the same (name, line) pair collide
 * on that slug and the second overwrites the first as a revision (card #251,
 * 2026-09-11: five fabric concepts all named "American Knits 2026" per line).
 * Checked post-expansion, so a `both` brief colliding with an explicit mens or
 * womens brief of the same name is caught too. Mens/womens briefs may share a
 * name — personas are per line, so they land in different collections.
 */
function findDuplicateBriefPair(briefs: DispatchBrief[], rawIndexOf: number[]): string | null {
  const firstSeenAt = new Map<string, number>();
  for (let idx = 0; idx < briefs.length; idx += 1) {
    const b = briefs[idx]!;
    const key = `${b.collection_name.toLowerCase()} ${b.line}`;
    const prevIdx = firstSeenAt.get(key);
    if (prevIdx !== undefined) {
      const first = rawIndexOf[prevIdx]! + 1;
      const second = rawIndexOf[idx]! + 1;
      return `two briefs share collection_name "${b.collection_name}" for line "${b.line}" (brief ${first}, brief ${second}); every concept needs its own collection name`;
    }
    firstSeenAt.set(key, idx);
  }
  return null;
}

/**
 * Normalize and check a model-drafted plan. `line: "both"` (and a missing
 * line) expands into a mens brief and a womens brief here, so every consumer
 * downstream sees one concrete line per brief.
 */
export function validateDispatchPlan(raw: unknown, nowIso: string): DispatchPlanResult {
  if (!isPlainObject(raw)) return { ok: false, error: 'plan must be an object' };

  const summary = trimmedString(raw.summary);
  if (!summary || summary.length > SUMMARY_MAX) {
    return { ok: false, error: `summary must be a non-empty string of at most ${SUMMARY_MAX} chars` };
  }

  const rawBriefs = listOf(raw.briefs, 'briefs');
  if (!rawBriefs.ok) return rawBriefs;
  const rawContacts = listOf(raw.vendor_contacts, 'vendor_contacts');
  if (!rawContacts.ok) return rawContacts;
  const rawRuns = listOf(raw.run_requests, 'run_requests');
  if (!rawRuns.ok) return rawRuns;

  const briefs: DispatchBrief[] = [];
  const briefRawIndex: number[] = [];
  for (const [i, b] of rawBriefs.items.entries()) {
    const r = validateBrief(b, i, nowIso);
    if (!r.ok) return r;
    for (const expanded of r.briefs) {
      briefs.push(expanded);
      briefRawIndex.push(i);
    }
  }

  const duplicate = findDuplicateBriefPair(briefs, briefRawIndex);
  if (duplicate) return { ok: false, error: duplicate };

  const vendor_contacts: DispatchVendorContact[] = [];
  for (const [i, c] of rawContacts.items.entries()) {
    const r = validateVendorContact(c, i);
    if (!r.ok) return r;
    vendor_contacts.push(r.contact);
  }

  const run_requests: DispatchRunRequest[] = [];
  for (const [i, q] of rawRuns.items.entries()) {
    const r = validateRunRequest(q, i);
    if (!r.ok) return r;
    run_requests.push(r.request);
  }

  if (briefs.length + vendor_contacts.length + run_requests.length === 0) {
    return { ok: false, error: 'a dispatch plan needs at least one brief, vendor contact or run request' };
  }
  // Bounds are checked after the `both` expansion: two lines is two Designer runs.
  if (briefs.length > MAX_BRIEFS) {
    return { ok: false, error: `a dispatch plan holds at most ${MAX_BRIEFS} briefs after expanding line "both"; this one has ${briefs.length}` };
  }
  if (vendor_contacts.length > MAX_VENDOR_CONTACTS) {
    return { ok: false, error: `a dispatch plan holds at most ${MAX_VENDOR_CONTACTS} vendor contacts` };
  }
  if (run_requests.length > MAX_RUN_REQUESTS) {
    return { ok: false, error: `a dispatch plan holds at most ${MAX_RUN_REQUESTS} run requests` };
  }

  return { ok: true, plan: { summary, briefs, vendor_contacts, run_requests } };
}

export interface ApprovedPersonaCounts { mens: number; womens: number }

/** The proposal `reason` column caps at 2000 chars (`validateProposal`). */
export const PLAN_REASON_CAP = 2000;
/** A brief_text line on the card is a reminder, not the brief. */
export const BRIEF_TEXT_LINE_CAP = 140;
/** Prefix of the designer-run estimate line, so a reader can find it again. */
export const ESTIMATE_PREFIX = 'Estimated ';

export interface RenderPlanOptions {
  /**
   * Show a truncated `brief_text` line under each Brief line when the plan has
   * at most this many briefs. The card does this for a small dispatch, where
   * there is room for Robert to read what he actually asked for.
   */
  briefTextMaxBriefs?: number;
  /**
   * The designer-run count when the caller already knows it (the card reads it
   * off the filed `evidence` rather than re-reading design-module). Ignored
   * when `personas` is given.
   */
  designRuns?: number | null;
}

function briefLine(b: DispatchBrief): string {
  let s = `Brief: ${b.collection_name} — ${b.line}`;
  if (b.product_count !== null) s += `, ${b.product_count} pieces`;
  if (b.price_ladder !== null) s += `, ${b.price_ladder.join('/')}`;
  if (b.fabric_locks !== null) s += `, fabrics: ${b.fabric_locks.join(', ')}`;
  if (b.vendor !== null) s += `, vendor: ${b.vendor}`;
  if (b.dye_program === 'pfd_house_dye') s += ', dye: PFD (we dye in-house)';
  else if (b.dye_program === 'vendor_dyed') s += ', dye: vendor-dyed';
  return `${s}, launch ${b.target_launch}`;
}

function contactLine(c: DispatchVendorContact): string {
  const head = `Contact: ${c.vendor_name} — `;
  if (c.contact_name && c.email) return `${head}${c.contact_name} <${c.email}>`;
  if (c.email) return `${head}<${c.email}>`;
  if (c.contact_name) return `${head}${c.contact_name}, no email on file`;
  return `${head}no email on file`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** The one line that tells Robert how much Designer work he is approving. */
export function estimateLine(briefCount: number, designRuns: number | null): string {
  return designRuns === null
    ? `${ESTIMATE_PREFIX}${briefCount} briefs × per approved persona designer runs.`
    : `${ESTIMATE_PREFIX}${designRuns} designer runs (${briefCount} briefs × approved personas).`;
}

/**
 * The plan in plain words — the card copy Robert reads on his phone and the
 * proposal's stored `reason`. `personas` is the approved-persona count per
 * line; `null` (with no `designRuns` override) downgrades the estimate line
 * rather than losing it.
 *
 * Every section sheds from the end — briefs first, then contacts, then run
 * requests — so the result is always <= PLAN_REASON_CAP for any valid plan,
 * whatever the caller put in the free-text fields.
 */
export function renderPlanReason(
  plan: DispatchPlan,
  personas: ApprovedPersonaCounts | null,
  opts: RenderPlanOptions = {},
): string {
  const showBriefText = opts.briefTextMaxBriefs !== undefined
    && plan.briefs.length <= opts.briefTextMaxBriefs;
  const briefBlocks = plan.briefs.map((b) => (showBriefText
    ? [briefLine(b), `  ${truncate(b.brief_text, BRIEF_TEXT_LINE_CAP)}`]
    : [briefLine(b)]));
  const contactLines = plan.vendor_contacts.map(contactLine);
  const runLines = plan.run_requests.map((r) => `Run: ${r.agent} — ${r.reason}`);

  const designRuns = personas
    ? plan.briefs.reduce((sum, b) => sum + personas[b.line], 0)
    : (opts.designRuns ?? null);
  const estimate = plan.briefs.length > 0 ? [estimateLine(plan.briefs.length, designRuns)] : [];

  const more = (kept: number, all: number, noun: string): string[] =>
    kept < all ? [`…and ${all - kept} more ${noun}`] : [];

  const assemble = (nb: number, nc: number, nr: number): string => [
    plan.summary,
    ...briefBlocks.slice(0, nb).flat(),
    ...more(nb, briefBlocks.length, 'briefs'),
    ...contactLines.slice(0, nc),
    ...more(nc, contactLines.length, 'vendor contacts'),
    ...runLines.slice(0, nr),
    ...more(nr, runLines.length, 'run requests'),
    ...estimate,
  ].join('\n');

  let nb = briefBlocks.length;
  let nc = contactLines.length;
  let nr = runLines.length;
  let text = assemble(nb, nc, nr);
  while (text.length > PLAN_REASON_CAP && (nb > 0 || nc > 0 || nr > 0)) {
    if (nb > 0) nb -= 1;
    else if (nc > 0) nc -= 1;
    else nr -= 1;
    text = assemble(nb, nc, nr);
  }
  return text;
}
