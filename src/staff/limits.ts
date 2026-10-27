/**
 * Checks on OPERATOR direct actions (spec 2026-10-27; Robert 2026-10-27: the
 * only hard limit is 25 units per SKU per transfer). A PO receipt is never
 * refused for its quantity: short and over lines run and each gets one
 * sentence for Robert. Pure: the caller reads the open PO first and passes it
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
  /** kanban-purchaser's PO line id: a positive integer (it answers 400 to anything else). */
  line_id?: number;
  sku?: string;
  quantity: number;
  unit?: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * A receipt against the open PO: any quantity runs. Each line received short
 * of, or over, its open quantity (ordered − already received) yields one
 * sentence for Robert. A line named twice is summed. A line not on the PO, a
 * SKU on several lines, or a unit other than the line's own (yards are not
 * rolls) is refused: those cannot be matched or compared safely.
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
    const still = line.received_quantity > 0 ? ` still open (${fmtQty(line.quantity)} ordered)` : ' ordered';
    const shown = line.received_quantity > 0 ? open : line.quantity;
    if (got < open) flags.push(`We only got ${fmtQty(got)} of the ${fmtQty(shown)} ${line.name}${still} on PO ${n}.`);
    if (got > open) flags.push(`We got ${fmtQty(got)} of the ${fmtQty(shown)} ${line.name}${still} on PO ${n}.`);
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
