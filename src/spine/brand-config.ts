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
  // Optional identity and settings (store-routing spec §1, decision 13). All
  // optional so a file written before these existed still loads.
  /** false parks the brand; absent means active. */
  active?: boolean;
  primary_domain?: string;
  /** Shopify location the brand fulfils from (a gid). */
  location_id?: string;
  /** Shopify location gid of the retail store (staff `/setlocation <email> store`). Internal; not served by publicBrandEntry. */
  store_location_id?: string;
  /** ISO 4217, e.g. USD. */
  currency?: string;
  /** IANA zone, e.g. America/Chicago. */
  timezone?: string;
  quickbooks_class?: string;
  /** Ad platform -> account id, e.g. { "google": "123-456-7890" }. `meta_ad_account` stays as is. */
  ad_accounts?: Record<string, string>;
  /** ESP list name -> list id. */
  esp_lists?: Record<string, string>;
  features?: Record<string, boolean>;
}

/**
 * What `GET /spine/brands/<slug>` serves to services that cannot read this
 * repo. A whitelist: hands (URLs and `*_env` key names), the inbox user and
 * the trust settings stay internal. Absent scalars are null and absent maps
 * are {} so the key set never varies.
 */
export interface PublicBrandEntry {
  brand_id: string;
  display_name: string;
  active: boolean;
  shopify_store: string | null;
  primary_domain: string | null;
  location_id: string | null;
  currency: string | null;
  timezone: string | null;
  quickbooks_class: string | null;
  meta_ad_account: string | null;
  ad_accounts: Record<string, string>;
  esp_lists: Record<string, string>;
  features: Record<string, boolean>;
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
  validateIdentity(parsed, file);
  return parsed;
}

const CURRENCY_RE = /^[A-Z]{3}$/;
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function isStringMap(v: unknown, valueOk: (x: unknown) => boolean): boolean {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && Object.values(v).every(valueOk);
}

function isTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

function validateIdentity(parsed: BrandConfig, file: string): void {
  const p = parsed as unknown as Record<string, unknown>;
  const fail = (field: string, rule: string) => { throw new Error(`${field} must be ${rule} in ${file}`); };
  const nonEmpty = (x: unknown) => typeof x === 'string' && x.trim().length > 0;
  if (p.active !== undefined && typeof p.active !== 'boolean') fail('active', 'true or false');
  if (p.primary_domain !== undefined && !(typeof p.primary_domain === 'string' && DOMAIN_RE.test(p.primary_domain))) fail('primary_domain', 'a lowercase domain name');
  if (p.location_id !== undefined && !nonEmpty(p.location_id)) fail('location_id', 'a non-empty string');
  if (p.store_location_id !== undefined && !nonEmpty(p.store_location_id)) fail('store_location_id', 'a non-empty string');
  if (p.currency !== undefined && !(typeof p.currency === 'string' && CURRENCY_RE.test(p.currency))) fail('currency', 'a 3-letter ISO 4217 code');
  if (p.timezone !== undefined && !(typeof p.timezone === 'string' && isTimeZone(p.timezone))) fail('timezone', 'an IANA time zone');
  if (p.quickbooks_class !== undefined && !nonEmpty(p.quickbooks_class)) fail('quickbooks_class', 'a non-empty string');
  if (p.ad_accounts !== undefined && !isStringMap(p.ad_accounts, nonEmpty)) fail('ad_accounts', 'an object of non-empty strings');
  if (p.esp_lists !== undefined && !isStringMap(p.esp_lists, nonEmpty)) fail('esp_lists', 'an object of non-empty strings');
  if (p.features !== undefined && !isStringMap(p.features, (x) => typeof x === 'boolean')) fail('features', 'an object of true/false flags');
}

export function isBrandActive(brand: BrandConfig): boolean {
  return brand.active !== false;
}

/** The registry entry minus everything internal; see PublicBrandEntry. */
export function publicBrandEntry(brand: BrandConfig): PublicBrandEntry {
  return {
    brand_id: brand.brand_id,
    display_name: brand.display_name,
    active: isBrandActive(brand),
    shopify_store: brand.shopify_store || null,
    primary_domain: brand.primary_domain ?? null,
    location_id: brand.location_id ?? null,
    currency: brand.currency ?? null,
    timezone: brand.timezone ?? null,
    quickbooks_class: brand.quickbooks_class ?? null,
    meta_ad_account: brand.meta_ad_account || null,
    ad_accounts: { ...(brand.ad_accounts ?? {}) },
    esp_lists: { ...(brand.esp_lists ?? {}) },
    features: { ...(brand.features ?? {}) },
  };
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
