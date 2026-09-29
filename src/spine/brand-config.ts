import fs from 'node:fs';
import path from 'node:path';

/**
 * Query keys the spine may stamp with the brand id on a hand call. Opt-in per
 * hand: `brand` already means something else on some hands (a contract
 * customer code on the PO receiver, a piece-work table filter on
 * quickbooks-sync), so a hand only receives the brand when its entry says so.
 */
export const FORWARD_BRAND_KEYS = ['brand', 'brandSlug'] as const;
export type ForwardBrandKey = (typeof FORWARD_BRAND_KEYS)[number];

export interface HandRef {
  url_env: string;
  key_env: string;
  /** When set, the hand proxy (reads) and the executor (writes) set this query key to the brand id. */
  forward_brand?: ForwardBrandKey;
}

export interface BrandConfig {
  brand_id: string;
  display_name: string;
  inbox_user_id: string;
  shopify_store: string;
  meta_ad_account: string;
  silent_budget_usd: number;
  exploration_share: number;
  proposal_expiry_hours: number;
  hands: Record<string, HandRef>;
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function listBrandIds(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
}

export function loadBrandConfig(dir: string, brandId: string): BrandConfig {
  if (!ID_RE.test(brandId)) throw new Error(`Invalid brand_id: ${brandId}`);
  const file = path.join(dir, `${brandId}.json`);
  if (!fs.existsSync(file)) throw new Error(`Unknown brand: ${brandId}`);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as BrandConfig;
  if (parsed.brand_id !== brandId) throw new Error(`brand_id mismatch in ${file}`);
  validateHands(parsed, file);
  return parsed;
}

function validateHands(parsed: BrandConfig, file: string): void {
  const hands = parsed.hands as unknown;
  if (typeof hands !== 'object' || hands === null || Array.isArray(hands)) {
    throw new Error(`hands must be an object in ${file}`);
  }
  for (const [name, ref] of Object.entries(hands as Record<string, unknown>)) {
    if (typeof ref !== 'object' || ref === null || Array.isArray(ref)) {
      throw new Error(`hand ${name} must be an object in ${file}`);
    }
    const fb = (ref as { forward_brand?: unknown }).forward_brand;
    if (fb !== undefined && !(FORWARD_BRAND_KEYS as readonly unknown[]).includes(fb)) {
      throw new Error(`hand ${name}: forward_brand must be one of ${FORWARD_BRAND_KEYS.join(', ')} in ${file}`);
    }
  }
}

/** The query key a hand wants the brand id under, or undefined when it opted out. */
export function forwardBrandKey(brand: BrandConfig, hand: string): ForwardBrandKey | undefined {
  return Object.hasOwn(brand.hands, hand) ? brand.hands[hand]!.forward_brand : undefined;
}

export function resolveHand(
  brand: BrandConfig,
  hand: string,
  env: Record<string, string | undefined>,
): { url: string; bearer: string } {
  const ref = Object.hasOwn(brand.hands, hand) ? brand.hands[hand] : undefined;
  if (!ref) throw new Error(`Unknown hand: ${hand} (brand ${brand.brand_id})`);
  const url = env[ref.url_env];
  const bearer = env[ref.key_env];
  if (!url) throw new Error(`Missing env ${ref.url_env} for hand ${hand}`);
  if (!bearer) throw new Error(`Missing env ${ref.key_env} for hand ${hand}`);
  return { url: url.replace(/\/+$/, ''), bearer };
}
