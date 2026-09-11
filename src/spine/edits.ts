import type { ActionPayload } from './types.js';

export type EditFields = Record<string, string | number | boolean>;

const HINT = 'Use key=value pairs, e.g. monthly_usd=10000';

const KEY = '[A-Za-z_][A-Za-z0-9_]*';
const LEADING_KEY = new RegExp(`^(${KEY})=`);
/** A second `key=` token somewhere after the first one. */
const FURTHER_KEY = new RegExp(`\\s${KEY}=`);

function coerce(raw: string): string | number | boolean {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

/**
 * Two shapes, decided by whether a second `key=` token appears:
 *
 *   `monthly_usd=10000 flag=false`  → two edits, split on whitespace.
 *   `summary=Only the waffle one`   → ONE edit whose value is the rest of the
 *                                     line, spaces and all.
 *
 * The second shape is what the graph card's "Edit: summary=<new text>" hint
 * promises; without it every multi-word value was rejected as free text.
 */
export function parseEdit(text: string): { ok: true; fields: EditFields } | { ok: false; reason: string } {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: false, reason: HINT };

  const lead = LEADING_KEY.exec(trimmed);
  if (!lead) return { ok: false, reason: HINT };

  const rest = trimmed.slice(lead[0].length);
  if (!FURTHER_KEY.test(rest)) {
    // Single edit: the whole remainder is the value. An empty one is not an
    // edit, it is a typo.
    const value = rest.trim();
    if (value.length === 0) return { ok: false, reason: HINT };
    return { ok: true, fields: { [lead[1]!]: coerce(value) } };
  }

  const fields: EditFields = {};
  for (const p of trimmed.split(/\s+/).filter(Boolean)) {
    const m = new RegExp(`^(${KEY})=(.+)$`).exec(p);
    if (!m) return { ok: false, reason: HINT };
    fields[m[1]!] = coerce(m[2]!);
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
    if (!Object.hasOwn(body, k)) return { ok: false, reason: `Unknown field: ${k}` };
    if (typeof body[k] !== typeof v) {
      return { ok: false, reason: `Field ${k} is ${typeof body[k]}, got ${typeof v}` };
    }
    body[k] = v;
  }
  return { ok: true, payload: { ...payload, body } };
}
