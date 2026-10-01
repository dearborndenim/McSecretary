/**
 * The `cash` briefing section (finance step F6): at most six lines from the
 * quickbooks-sync hand, company-wide.
 *
 * Reads, resolved the same way as the spine's read-only hand proxy (brand
 * file -> env names -> URL + bearer), never with a key of its own:
 *   GET /api/integration/cash-forecast   (required; quickbooks-sync PR #4)
 *   GET /api/integration/finance-week    (cash today, last completed week)
 *   GET /api/integration/loans           (debt service due in 14 days)
 *   GET /api/integration/unassigned      (transactions not yet classed)
 *
 * Failure isolation: if the hand is unreachable or cash-forecast is missing
 * (404 until PR #4 deploys), the section is omitted and one line is logged.
 * A failed optional read only drops its own line. Nothing here throws.
 */
import { loadBrandConfig, resolveHand } from '../spine/brand-config.js';
import { resolveHandUrl } from '../spine/executor.js';

export const CASH_HAND = 'quickbooks-sync';
/** quickbooks-sync is not brand-forwarded, so every read is company-wide. */
const CASH_BRAND_ID = 'dearborn-denim';
const URGENT_WITHIN_DAYS = 28;
const DEBT_WINDOW_DAYS = 14;
const MAX_LINES = 6;
const DAY_MS = 86_400_000;

export interface CashForecast {
  ending_cash: Array<{ week_start: string; ending_cash_usd: number }>;
  low_point_usd: number;
  low_point_week: string;
  /** low point minus the stored cash floor; null when no policy is stored. */
  headroom_usd: number | null;
}

export interface FinanceWeekCash {
  cash_total_usd: number;
  weeks: Array<{ week_start: string; revenue_usd: number; expenses_usd: number }>;
}

export interface LoanDue { lender: string; payment: number; next_due: string | null; active: boolean }

export interface CashSectionData {
  /** YYYY-MM-DD in America/Chicago. */
  today: string;
  forecast: CashForecast;
  financeWeek?: FinanceWeekCash;
  loans?: LoanDue[];
  unassigned?: { count: number; amount_usd: number };
}

// ---------------------------------------------------------------------------
// Parsing (the external boundary): anything off-shape is treated as missing.
// ---------------------------------------------------------------------------

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const obj = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

export function parseCashForecast(raw: unknown): CashForecast | null {
  const o = obj(raw);
  if (!o || !Array.isArray(o.ending_cash) || o.ending_cash.length === 0) return null;
  const weeks = o.ending_cash.map(obj);
  if (weeks.some((w) => !w || !isDate(w.week_start) || !isNum(w.ending_cash_usd))) return null;
  if (!isNum(o.low_point_usd) || !isDate(o.low_point_week)) return null;
  if (o.headroom_usd !== null && !isNum(o.headroom_usd)) return null;
  return {
    ending_cash: weeks.map((w) => ({ week_start: w!.week_start as string, ending_cash_usd: w!.ending_cash_usd as number })),
    low_point_usd: o.low_point_usd,
    low_point_week: o.low_point_week,
    headroom_usd: o.headroom_usd as number | null,
  };
}

export function parseFinanceWeek(raw: unknown): FinanceWeekCash | null {
  const o = obj(raw);
  const cash = obj(o?.cash);
  if (!o || !cash || !isNum(cash.total) || !Array.isArray(o.weeks)) return null;
  const weeks = o.weeks.map(obj).filter((w): w is Record<string, unknown> =>
    !!w && isDate(w.week_start) && isNum(w.revenue_usd) && isNum(w.expenses_usd));
  return {
    cash_total_usd: cash.total,
    weeks: weeks.map((w) => ({ week_start: w.week_start as string, revenue_usd: w.revenue_usd as number, expenses_usd: w.expenses_usd as number })),
  };
}

export function parseLoans(raw: unknown): LoanDue[] | null {
  const o = obj(raw);
  if (!o || !Array.isArray(o.loans)) return null;
  return o.loans.map(obj).filter((l): l is Record<string, unknown> => !!l && isNum(l.payment)).map((l) => ({
    lender: typeof l.lender === 'string' ? l.lender : 'loan',
    payment: l.payment as number,
    next_due: isDate(l.next_due) ? l.next_due : null,
    active: l.active !== false,
  }));
}

export function parseUnassigned(raw: unknown): { count: number; amount_usd: number } | null {
  const o = obj(raw);
  if (!o || !isNum(o.count)) return null;
  return { count: o.count, amount_usd: isNum(o.amount_usd) ? o.amount_usd : 0 };
}

// ---------------------------------------------------------------------------
// Formatting (pure)
// ---------------------------------------------------------------------------

const dayNum = (iso: string): number => Date.parse(`${iso}T00:00:00Z`) / DAY_MS;
const addDays = (iso: string, n: number): string => new Date((dayNum(iso) + n) * DAY_MS).toISOString().slice(0, 10);
const md = (iso: string): string => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;

/** Whole dollars, sign before the $: 102370.06 -> "$102,370", -50.1 -> "-$50". */
export function usd(n: number): string {
  const r = Math.round(n);
  return `${r < 0 ? '-' : ''}$${Math.abs(r).toLocaleString('en-US')}`;
}

/** Monday of the ISO week containing `iso`. */
function mondayOf(iso: string): string {
  const dow = new Date(dayNum(iso) * DAY_MS).getUTCDay(); // 0 = Sunday
  return addDays(iso, -((dow + 6) % 7));
}

/** Monday of the last fully completed ISO week before `today`. */
export function lastCompletedWeekStart(today: string): string {
  return addDays(mondayOf(today), -7);
}

function lowPointLine(f: CashForecast, today: string): string {
  const low = `${usd(f.low_point_usd)} in the week of ${md(f.low_point_week)}`;
  if (f.headroom_usd === null) return `13-week low: ${low} (no cash floor stored).`;
  const floor = Math.round((f.low_point_usd - f.headroom_usd) * 100) / 100;
  if (f.headroom_usd >= 0) return `13-week low: ${low}, ${usd(f.headroom_usd)} over the ${usd(floor)} floor.`;
  const breach = f.ending_cash.find((w) => w.ending_cash_usd < floor)!;
  const under = `${usd(-f.headroom_usd)} under the ${usd(floor)} floor`;
  if (dayNum(breach.week_start) - dayNum(today) < URGENT_WITHIN_DAYS) {
    return `URGENT: cash falls below the ${usd(floor)} floor in the week of ${md(breach.week_start)} `
      + `(${usd(breach.ending_cash_usd)}); 13-week low ${low}, ${under}.`;
  }
  return `13-week low: ${low}, ${under} (first below it the week of ${md(breach.week_start)}).`;
}

/** The section text, or null when there is nothing to show. Never more than six lines. */
export function formatCashSection(d: CashSectionData): string | null {
  const lines: string[] = [];
  if (d.financeWeek) lines.push(`Cash today: ${usd(d.financeWeek.cash_total_usd)} in the bank.`);
  lines.push(lowPointLine(d.forecast, d.today));

  const lastStart = lastCompletedWeekStart(d.today);
  const last = d.financeWeek?.weeks.find((w) => w.week_start === lastStart);
  if (last) {
    lines.push(`Last week (${md(last.week_start)}): revenue ${usd(last.revenue_usd)}, expenses ${usd(last.expenses_usd)}.`);
  }

  const active = (d.loans ?? []).filter((l) => l.active);
  if (active.length > 0) {
    const end = addDays(d.today, DEBT_WINDOW_DAYS);
    const due = active
      .filter((l) => l.next_due !== null && l.next_due >= d.today && l.next_due <= end)
      .sort((a, b) => a.next_due!.localeCompare(b.next_due!));
    const total = due.reduce((s, l) => s + l.payment, 0);
    const detail = due.length === 0 ? '' : ` (${due.slice(0, 3).map((l) => `${l.lender} ${md(l.next_due!)} ${usd(l.payment)}`).join('; ')}${due.length > 3 ? `; +${due.length - 3} more` : ''})`;
    lines.push(`Debt service due by ${md(end)}: ${usd(total)}${detail}.`);
  }

  if (d.unassigned && d.unassigned.count > 0) {
    lines.push(`Unassigned transactions last week: ${d.unassigned.count} (${usd(d.unassigned.amount_usd)}), not yet classed in QuickBooks.`);
  }

  // URGENT leads, so a model summarising the briefing cannot bury it.
  lines.sort((a, b) => Number(b.startsWith('URGENT:')) - Number(a.startsWith('URGENT:')));
  return ['CASH (company-wide, from QuickBooks):', ...lines].slice(0, MAX_LINES).join('\n');
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export interface CashLoadDeps {
  brandsDir: string;
  env: Record<string, string | undefined>;
  /** Owns the timeout, like the spine's handFetch. */
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** YYYY-MM-DD in America/Chicago. */
  today: string;
  log?: (msg: string) => void;
}

type Read = { ok: true; body: unknown } | { ok: false; why: string };

/**
 * Fetch and format the section. Returns null (and logs exactly one line) when
 * the hand is unreachable or cash-forecast is unavailable; never throws.
 */
export async function buildCashSection(deps: CashLoadDeps): Promise<string | null> {
  const log = deps.log ?? ((m: string) => console.log(m));
  let target: { url: string; bearer: string };
  try {
    target = resolveHand(loadBrandConfig(deps.brandsDir, CASH_BRAND_ID), CASH_HAND, deps.env);
  } catch (err) {
    log(`Skipping cash section: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }

  const read = async (path: string, query = ''): Promise<Read> => {
    const resolved = resolveHandUrl(target.url, path);
    if (!resolved.ok) return { ok: false, why: `${path} ${resolved.error}` };
    try {
      const res = await deps.fetch(`${resolved.href}${query ? `?${query}` : ''}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${target.bearer}`, Accept: 'application/json' },
      });
      if (!res.ok) {
        void res.body?.cancel().catch(() => {});
        return { ok: false, why: `${path} ${res.status}` };
      }
      return { ok: true, body: await res.json() };
    } catch (err) {
      return { ok: false, why: `${path} ${err instanceof Error ? err.message : String(err)}` };
    }
  };

  const [fc, fw, ln, un] = await Promise.all([
    read('/api/integration/cash-forecast'),
    read('/api/integration/finance-week', 'weeks=3'),
    read('/api/integration/loans'),
    read('/api/integration/unassigned', `week=${lastCompletedWeekStart(deps.today)}&limit=1`),
  ]);

  const forecast = fc.ok ? parseCashForecast(fc.body) : null;
  if (!forecast) {
    log(`Skipping cash section: ${fc.ok ? 'cash-forecast response has no plan weeks' : fc.why}`);
    return null;
  }
  const missing: string[] = [];
  const pick = <T>(r: Read, parse: (b: unknown) => T | null, name: string): T | undefined => {
    const v = r.ok ? parse(r.body) : null;
    if (v === null) missing.push(r.ok ? `${name} off-shape` : r.why);
    return v ?? undefined;
  };
  const data: CashSectionData = {
    today: deps.today,
    forecast,
    financeWeek: pick(fw, parseFinanceWeek, 'finance-week'),
    loans: pick(ln, parseLoans, 'loans'),
    unassigned: pick(un, parseUnassigned, 'unassigned'),
  };
  if (missing.length > 0) log(`Cash section without some lines: ${missing.join('; ')}`);
  return formatCashSection(data);
}
