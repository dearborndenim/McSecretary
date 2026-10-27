/**
 * Hard limits on OPERATOR direct actions (spec 2026-10-27 "First actions").
 * Pure: the caller reads the current count / the open PO first and passes it
 * in. A refusal reason is one plain sentence OPERATOR can relay as-is.
 */

import { isPlainObject as isObj } from '../spine/json-object.js';
import type { ActionLimits } from './catalogue.js';

export type LimitCheck =
  | { ok: true; flags: string[]; detail: Record<string, unknown> }
  | { ok: false; reason: string; detail: Record<string, unknown> };

/** 37, 2.5, 0.33: whole numbers bare, others to 2 places. */
export function fmtQty(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

/**
 * A recount of one SKU from `current` to `next`. Every rule must hold, exactly
 * as written in the spec: |next − current| ≤ max_change_units AND ≤
 * max_change_pct % of current, and at most max_units_counted units counted in
 * the request (one SKU per request, so that is `next`).
 */
export function checkCountChange(current: number, next: number, l: NonNullable<ActionLimits['count']>): LimitCheck {
  const delta = Math.abs(next - current);
  // Integer cross-multiplication: 5% of 100 is exactly 5, never 5.000000001.
  const pctOk = delta * 100 <= l.max_change_pct * current;
  const detail = { current, next, change: delta };
  const reasons: string[] = [];
  if (next > l.max_units_counted) reasons.push(`${fmtQty(next)} units counted is more than the ${fmtQty(l.max_units_counted)} allowed per request`);
  if (delta > l.max_change_units) reasons.push(`a change of ${fmtQty(delta)} is more than ${fmtQty(l.max_change_units)} units`);
  if (!pctOk) {
    const allowed = Math.floor((l.max_change_pct * current) / 100);
    reasons.push(`a change of ${fmtQty(delta)} is more than ${fmtQty(l.max_change_pct)}% of the current ${fmtQty(current)} (at most ${allowed})`);
  }
  if (reasons.length === 0) return { ok: true, flags: [], detail };
  return { ok: false, reason: `Count ${fmtQty(current)} → ${fmtQty(next)} refused: ${reasons.join('; ')}. Nothing was changed.`, detail };
}

export function checkPerSku(quantity: number, sku: string, l: NonNullable<ActionLimits['per_sku']>): LimitCheck {
  const detail = { sku, quantity, max_units: l.max_units };
  if (quantity <= l.max_units) return { ok: true, flags: [], detail };
  return { ok: false, reason: `${fmtQty(quantity)} × ${sku} is more than the ${fmtQty(l.max_units)} units per SKU allowed per request. Nothing was moved.`, detail };
}

/** A PO line as kanban-purchaser's GET /api/integration/pos?status=ordered lists it. */
export interface OpenPoLine {
  line_id: number | string;
  sku: string;
  name: string;
  unit: string | null;
  quantity: number;
  received_quantity: number;
}
export interface OpenPo {
  id: number | string;
  po_number: number | string;
  lines: OpenPoLine[];
}
export interface ReceiptLine {
  line_id?: string;
  sku?: string;
  quantity: number;
  unit?: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Each requested line at most its open quantity (ordered − already received):
 * over is refused, short runs and yields one sentence per short line for
 * Robert. A line named twice is summed. A unit other than the line's own
 * cannot be compared, so it is refused rather than guessed.
 */
export function checkPoReceipt(po: OpenPo, lines: ReceiptLine[]): LimitCheck {
  const n = String(po.po_number);
  const totals = new Map<OpenPoLine, number>();
  for (const l of lines) {
    let hit: OpenPoLine | undefined;
    if (l.line_id !== undefined) {
      hit = po.lines.find((x) => String(x.line_id) === String(l.line_id));
      if (!hit) return { ok: false, reason: `Line ${l.line_id} is not on PO ${n}. Nothing was received.`, detail: { po_number: n } };
    } else {
      const sku = (l.sku ?? '').toLowerCase();
      const hits = po.lines.filter((x) => x.sku.toLowerCase() === sku);
      if (hits.length === 0) return { ok: false, reason: `No line on PO ${n} is SKU ${l.sku}. Nothing was received.`, detail: { po_number: n } };
      if (hits.length > 1) return { ok: false, reason: `SKU ${l.sku} is on ${hits.length} lines of PO ${n}; name the line_id. Nothing was received.`, detail: { po_number: n } };
      hit = hits[0]!;
    }
    if (l.unit !== undefined && (hit.unit ?? '').toLowerCase() !== l.unit.toLowerCase()) {
      return { ok: false, reason: `PO ${n} counts ${hit.name} in ${hit.unit ?? 'its own unit'}, not ${l.unit}; give the quantity in ${hit.unit ?? 'that unit'}. Nothing was received.`, detail: { po_number: n } };
    }
    totals.set(hit, round2((totals.get(hit) ?? 0) + l.quantity));
  }
  const flags: string[] = [];
  const checked: Record<string, unknown>[] = [];
  for (const [line, got] of totals) {
    const open = Math.max(0, round2(line.quantity - line.received_quantity));
    checked.push({ line_id: line.line_id, sku: line.sku, ordered: line.quantity, received_before: line.received_quantity, open, receiving: got });
    if (got > open) {
      return {
        ok: false,
        reason: `PO ${n}: ${fmtQty(got)} ${line.name} is more than the ${fmtQty(open)} still open (${fmtQty(line.quantity)} ordered). Nothing was received; the office decides about the extra.`,
        detail: { po_number: n, lines: checked },
      };
    }
    if (got < open) {
      flags.push(line.received_quantity > 0
        ? `We only got ${fmtQty(got)} of the ${fmtQty(open)} ${line.name} still open (${fmtQty(line.quantity)} ordered) on PO ${n}.`
        : `We only got ${fmtQty(got)} of the ${fmtQty(line.quantity)} ${line.name} ordered on PO ${n}.`);
    }
  }
  return { ok: true, flags, detail: { po_number: n, lines: checked } };
}

/** The open PO with kanban id `poId` out of the PO list answer, or null. Lines with a bad shape are dropped. */
export function findOpenPo(body: unknown, poId: string): OpenPo | null {
  if (!isObj(body) || !Array.isArray(body.pos)) return null;
  const po = body.pos.find((p) => isObj(p) && String(p.id) === poId);
  if (!isObj(po) || !Array.isArray(po.lines)) return null;
  const lines: OpenPoLine[] = [];
  for (const l of po.lines) {
    if (!isObj(l) || typeof l.sku !== 'string' || typeof l.quantity !== 'number') continue;
    lines.push({
      line_id: l.line_id as number | string,
      sku: l.sku,
      name: typeof l.name === 'string' && l.name ? l.name : l.sku,
      unit: typeof l.unit === 'string' ? l.unit : null,
      quantity: l.quantity,
      received_quantity: typeof l.received_quantity === 'number' ? l.received_quantity : 0,
    });
  }
  return { id: po.id as number | string, po_number: (po.po_number as number | string) ?? poId, lines };
}

/**
 * The current count of `sku` at `level` ('store' | 'factory') out of
 * factory-fenix's inventory lookup answer; null when the SKU is not an exact
 * match or has no level there (not stocked = cannot be checked = refused).
 */
export function currentCount(body: unknown, sku: string, level: 'store' | 'factory'): number | null {
  if (!isObj(body) || !Array.isArray(body.variants)) return null;
  const v = body.variants.find((x) => isObj(x) && typeof x.sku === 'string' && x.sku.toLowerCase() === sku.toLowerCase());
  if (!isObj(v) || !isObj(v.levels)) return null;
  const n = v.levels[level];
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}
