/**
 * `vendor_po_lookup` on the OPERATOR path (operator `answer: "open_pos"`):
 * kanban-purchaser's open-PO list (`GET /api/integration/pos?status=ordered`,
 * POs ORDERED or PARTIALLY_RECEIVED with their lines, newest 200) shaped so a
 * bot can tell an employee what is on a PO and what is still open, and receive
 * by line_id. Pure: grok-action.ts does the reads.
 *
 * kanban takes `vendor=` (name or code, substring) but no PO filter, so `po`
 * and `q` are matched here; when the list is cut at 200 and `q` is given, the
 * caller reads again with `vendor=q` to reach older POs of that vendor.
 */

import { isPlainObject as isObj } from '../spine/json-object.js';

/** kanban's LIMIT on the open-PO list. */
export const KANBAN_PO_LIST_LIMIT = 200;
/**
 * The most JSON this answer may be: under grok-action's 32,000-char result
 * cap (which would turn it into truncated text), with room for the envelope.
 */
export const PO_ANSWER_MAX = 30_000;
const LINES_HINT = 'name one with po for its lines.';

/** A PO without its lines: what an unfiltered lookup, or an over-long one, answers per PO. */
export interface PoSummary {
  po_id: unknown;
  po_number: unknown;
  vendor: unknown;
  status: unknown;
  expected_delivery: unknown;
  open_lines: number;
  open_units: number;
}

export interface PoLookupLine {
  line_id: unknown;
  sku: unknown;
  name: unknown;
  unit: unknown;
  ordered: number | null;
  received: number | null;
  open: number | null;
  [k: string]: unknown;
}

export interface PoLookupPo {
  po_id: unknown;
  po_number: unknown;
  vendor: unknown;
  status: unknown;
  lines: PoLookupLine[];
  [k: string]: unknown;
}

export interface PoLookupAnswer {
  as_of: string | null;
  match: { po?: string; q?: string };
  count: number;
  pos: (PoLookupPo | PoSummary)[];
  /** A plain sentence when nothing matched (not a failure). */
  message?: string;
  /** kanban's list was cut at 200 and the filter could not reach past it. */
  partial?: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** kanban's numeric columns may arrive as numbers or numeric strings. */
function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** One kanban line: quantity → ordered, received_quantity → received, open = ordered − received (≥ 0); other fields kept. */
export function mapPoLine(l: Record<string, unknown>): PoLookupLine {
  const { line_id, sku, name, unit, quantity, received_quantity, ...rest } = l;
  const ordered = num(quantity);
  const received = num(received_quantity) ?? (ordered === null ? null : 0);
  const open = ordered === null ? null : Math.max(0, round2(ordered - (received ?? 0)));
  return { line_id, sku, name: name ?? sku ?? null, unit: unit ?? null, ordered, received, open, ...rest };
}

/** One kanban PO: id → po_id, lines mapped, every other field (dates, carrier, tracking, notes) passed through unchanged. */
export function mapPo(p: Record<string, unknown>): PoLookupPo {
  const { id, po_number, vendor, status, lines, ...rest } = p;
  return {
    po_id: id ?? null,
    po_number: po_number ?? null,
    vendor: vendor ?? null,
    status: status ?? null,
    ...rest,
    lines: Array.isArray(lines) ? lines.filter(isObj).map(mapPoLine) : [],
  };
}

/** The PO as one summary row: lines with something open, and the open quantity summed across them (any unit). */
export function summarisePo(p: PoLookupPo): PoSummary {
  const open = p.lines.filter((l) => (l.open ?? 0) > 0);
  return {
    po_id: p.po_id, po_number: p.po_number, vendor: p.vendor, status: p.status,
    expected_delivery: p.expected_delivery ?? null,
    open_lines: open.length,
    open_units: round2(open.reduce((n, l) => n + (l.open ?? 0), 0)),
  };
}

const size = (v: unknown) => JSON.stringify(v).length;

/**
 * Keep the answer under PO_ANSWER_MAX: the oldest POs (kanban lists newest
 * first) lose their lines first, then, if summaries alone are still too
 * long, the oldest summaries go. Either way `partial` says so.
 */
function fitAnswer(answer: PoLookupAnswer): PoLookupAnswer {
  if (size(answer) <= PO_ANSWER_MAX) return answer;
  const pos = [...answer.pos];
  const out = { ...answer, pos };
  for (let i = pos.length - 1; i >= 0 && size(out) > PO_ANSWER_MAX; i--) {
    const p = pos[i]!;
    if ('lines' in p) pos[i] = summarisePo(p);
  }
  let dropped = 0;
  while (pos.length > 0 && size(out) > PO_ANSWER_MAX) { pos.pop(); dropped++; }
  const why = dropped
    ? `Too many POs to list; the oldest ${dropped} were left out and the rest are summaries; ${LINES_HINT}`
    : `Too long to list every line; the oldest POs are summaries without lines; ${LINES_HINT}`;
  out.partial = answer.partial ? `${answer.partial} ${why}` : why;
  return out;
}

/** "PO 1003", "po#1003", "#1003", " 1003 " → "1003". */
export function normalisePoRef(ref: string): string {
  return ref.trim().replace(/^po\s*/i, '').replace(/^#\s*/, '').trim();
}

/** The PO a reference names: its PO number first, then its kanban id. */
export function findPo(pos: Record<string, unknown>[], ref: string): Record<string, unknown> | undefined {
  const n = normalisePoRef(ref).toLowerCase();
  return pos.find((p) => String(p.po_number ?? '').toLowerCase() === n)
    ?? pos.find((p) => String(p.id ?? '').toLowerCase() === n);
}

/** q matches the vendor name or code, or any line's SKU or name (substring, case ignored). */
export function matchesQ(p: Record<string, unknown>, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  const has = (v: unknown) => typeof v === 'string' && v.toLowerCase().includes(needle);
  if (has(p.vendor) || has(p.vendor_code)) return true;
  return Array.isArray(p.lines) && p.lines.some((l) => isObj(l) && (has(l.sku) || has(l.name)));
}

export function poList(body: unknown): Record<string, unknown>[] {
  return isObj(body) && Array.isArray(body.pos) ? body.pos.filter(isObj) : [];
}

/**
 * The answer from kanban's list (and, when the list was cut and `q` is given,
 * the `vendor=q` re-read merged in). A PO named in `po` that is not in the
 * open list answers ok with no POs and a plain sentence saying so.
 */
export function poLookupAnswer(body: unknown, f: { po?: string; q?: string }, vendorBody?: unknown): PoLookupAnswer {
  const first = poList(body);
  const truncated = first.length >= KANBAN_PO_LIST_LIMIT;
  const all = [...first];
  const seen = new Set(first.map((p) => String(p.id)));
  for (const p of poList(vendorBody)) if (!seen.has(String(p.id))) { all.push(p); seen.add(String(p.id)); }

  const po = typeof f.po === 'string' && f.po.trim() ? f.po.trim() : undefined;
  const q = typeof f.q === 'string' && f.q.trim() ? f.q.trim() : undefined;
  let hits = all;
  if (po) { const hit = findPo(all, po); hits = hit ? [hit] : []; }
  if (q) hits = hits.filter((p) => matchesQ(p, q));

  const answer: PoLookupAnswer = {
    as_of: isObj(body) && typeof body.as_of === 'string' ? body.as_of : null,
    match: { ...(po ? { po } : {}), ...(q ? { q } : {}) },
    count: hits.length,
    pos: po || q ? hits.map(mapPo) : hits.map((p) => summarisePo(mapPo(p))),
  };
  if (!po && !q && hits.length > 0) answer.message = `${hits.length} open PO${hits.length === 1 ? '' : 's'}; ${LINES_HINT}`;
  const label = po ? `PO ${normalisePoRef(po)}` : '';
  if (hits.length === 0) {
    answer.message = po && q && findPo(all, po)
      ? `${label} is open, but nothing on it matches "${q}".`
      : po ? `${label} isn't open for receiving.`
        : q ? `No open PO matches "${q}".` : 'There are no open POs.';
  }
  // Only the newest 200 open POs come back; say so when a filter could have missed an older one.
  // A po has no kanban filter; a q was re-read by vendor, which reaches older POs of that vendor only.
  if (truncated && hits.length === 0 && (po || q)) {
    answer.partial = `kanban lists only the newest ${KANBAN_PO_LIST_LIMIT} open POs, so an older open PO would not show here.`;
  } else if (truncated && !po && !q) {
    answer.partial = `kanban lists only the newest ${KANBAN_PO_LIST_LIMIT} open POs; name a PO or a vendor to look further.`;
  }
  return fitAnswer(answer);
}
