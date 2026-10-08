/**
 * One read-only GET against a hand, shared by the admin `read_hand` chat tool
 * (src/graph/tools.ts) and the staff look-ups (src/staff/execute.ts): the
 * path must stay under /api/integration/ with no relative segments, the
 * request carries the hand's bearer, it is aborted after a timeout, and the
 * text handed to the model is capped at 8 KB.
 */

import { forwardBrandKey, resolveHand, type BrandConfig } from './brand-config.js';
import { resolveHandUrl, withForwardedBrand } from './executor.js';

export const HAND_READ_PATH_PREFIX = '/api/integration/';
export const HAND_READ_CAP_BYTES = 8192;
const DEFAULT_READ_TIMEOUT_MS = 20_000;

export type HandReadResult =
  | { ok: true; status: number; text: string; capped: string }
  | { ok: false; reason: 'prefix' | 'relative' | 'config' | 'path'; error: string };

export function capHandText(text: string): string {
  return text.length > HAND_READ_CAP_BYTES ? `${text.slice(0, HAND_READ_CAP_BYTES)}…[truncated]` : text;
}

export async function readHandPath(o: {
  brand: BrandConfig;
  hand: string;
  path: string;
  env: Record<string, string | undefined>;
  handFetch: (url: string, init: RequestInit) => Promise<Response>;
  query?: [string, string][];
  /** Add the brand under the hand's `forward_brand` key, as the hand proxy does. */
  forwardBrand?: boolean;
  timeoutMs?: number;
}): Promise<HandReadResult> {
  if (!o.path.startsWith(HAND_READ_PATH_PREFIX)) {
    return { ok: false, reason: 'prefix', error: `only ${HAND_READ_PATH_PREFIX} paths can be read` };
  }
  // `..`/`.` segments would resolve back out of the integration prefix.
  if (o.path.split('?')[0]!.split('/').some((seg) => seg === '.' || seg === '..')) {
    return { ok: false, reason: 'relative', error: 'path has relative segments' };
  }
  let target: { url: string; bearer: string };
  try { target = resolveHand(o.brand, o.hand, o.env); }
  catch (err) { return { ok: false, reason: 'config', error: err instanceof Error ? err.message : String(err) }; }
  const resolved = resolveHandUrl(target.url, o.path);
  if (!resolved.ok) return { ok: false, reason: 'path', error: resolved.error };
  const url = new URL(resolved.href);
  for (const [k, v] of o.query ?? []) url.searchParams.set(k, v);
  const href = o.forwardBrand
    ? withForwardedBrand(url.href, forwardBrandKey(o.brand, o.hand), o.brand.brand_id)
    : url.href;
  const res = await o.handFetch(href, {
    method: 'GET',
    headers: { Authorization: `Bearer ${target.bearer}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(o.timeoutMs ?? DEFAULT_READ_TIMEOUT_MS),
  });
  const text = await res.text();
  return { ok: true, status: res.status, text, capped: capHandText(text) };
}
