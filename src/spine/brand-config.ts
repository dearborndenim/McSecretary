import fs from 'node:fs';
import path from 'node:path';

export interface HandRef { url_env: string; key_env: string }

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
  return parsed;
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
