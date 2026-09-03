import crypto from 'node:crypto';
import type { ActionPayload } from './types.js';

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonical(v === undefined ? null : v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
}

/** sha256 of the canonical (key-sorted) JSON of the payload. Arrays keep order. */
export function hashPayload(payload: ActionPayload): string {
  return crypto.createHash('sha256').update(canonical(payload)).digest('hex');
}
