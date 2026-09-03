import type { ActionPayload } from './types.js';

export type EditFields = Record<string, string | number | boolean>;

const HINT = 'Use key=value pairs, e.g. monthly_usd=10000';

export function parseEdit(text: string): { ok: true; fields: EditFields } | { ok: false; reason: string } {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { ok: false, reason: HINT };
  const fields: EditFields = {};
  for (const p of parts) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/.exec(p);
    if (!m) return { ok: false, reason: HINT };
    const key = m[1]!;
    const raw = m[2]!;
    if (raw === 'true') fields[key] = true;
    else if (raw === 'false') fields[key] = false;
    else if (/^-?\d+(\.\d+)?$/.test(raw)) fields[key] = Number(raw);
    else fields[key] = raw;
  }
  return { ok: true, fields };
}

/** Apply edits to `payload.body` only. Keys must exist and keep their type. */
export function applyEdit(
  payload: ActionPayload,
  fields: EditFields,
): { ok: true; payload: ActionPayload } | { ok: false; reason: string } {
  const body: Record<string, unknown> = { ...payload.body };
  for (const [k, v] of Object.entries(fields)) {
    if (!(k in body)) return { ok: false, reason: `Unknown field: ${k}` };
    if (typeof body[k] !== typeof v) {
      return { ok: false, reason: `Field ${k} is ${typeof body[k]}, got ${typeof v}` };
    }
    body[k] = v;
  }
  return { ok: true, payload: { ...payload, body } };
}
