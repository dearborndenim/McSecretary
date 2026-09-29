import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { loadBrandConfig, resolveHand, listBrandIds, forwardBrandKey } from '../../src/spine/brand-config.js';

const DIR = path.join(process.cwd(), 'config', 'brands');

describe('brand config', () => {
  it('loads dearborn-denim and lists it', () => {
    expect(listBrandIds(DIR)).toContain('dearborn-denim');
    const b = loadBrandConfig(DIR, 'dearborn-denim');
    expect(b.brand_id).toBe('dearborn-denim');
    expect(b.inbox_user_id).toBe('robert-mcmillan');
    expect(b.exploration_share).toBe(0.2);
    expect(b.silent_budget_usd).toBe(500);
    expect(Object.keys(b.hands)).toEqual(expect.arrayContaining(['ad-manager', 'content-engine', 'product-dev']));
  });

  it('resolves a hand to url + bearer from env', () => {
    const b = loadBrandConfig(DIR, 'dearborn-denim');
    const r = resolveHand(b, 'ad-manager', { AD_MANAGER_URL: 'https://am.example', AD_MANAGER_KEY: 'k1' });
    expect(r).toEqual({ url: 'https://am.example', bearer: 'k1' });
  });

  it('throws on unknown brand or hand, and on missing env', () => {
    expect(() => loadBrandConfig(DIR, 'nope')).toThrow(/Unknown brand/);
    const b = loadBrandConfig(DIR, 'dearborn-denim');
    expect(() => resolveHand(b, 'nope', {})).toThrow(/Unknown hand/);
    expect(() => resolveHand(b, 'ad-manager', {})).toThrow(/AD_MANAGER_URL/);
  });

  it('rejects brand_id with path characters', () => {
    expect(() => loadBrandConfig(DIR, '../x')).toThrow(/Invalid brand_id/);
  });

  it('forwards the brand to design-module and product-dev only, for dearborn-denim', () => {
    const b = loadBrandConfig(DIR, 'dearborn-denim');
    const forwarding = Object.keys(b.hands).filter((h) => forwardBrandKey(b, h) !== undefined).sort();
    expect(forwarding).toEqual(['design-module', 'product-dev']);
    expect(forwardBrandKey(b, 'design-module')).toBe('brand');
    expect(forwardBrandKey(b, 'product-dev')).toBe('brand');
    // `brand` means a contract customer code on the PO receiver: never forwarded there.
    expect(forwardBrandKey(b, 'purchase-order-receiver')).toBeUndefined();
    expect(forwardBrandKey(b, 'notes')).toBeUndefined();
  });

  describe('forward_brand validation', () => {
    let tmp = '';
    const base = JSON.parse(fs.readFileSync(path.join(DIR, 'dearborn-denim.json'), 'utf8')) as Record<string, unknown>;
    const write = (hands: unknown): void => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brands-'));
      fs.writeFileSync(path.join(tmp, 'x.json'), JSON.stringify({ ...base, brand_id: 'x', hands }));
    };
    afterEach(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

    it('accepts brand and brandSlug', () => {
      write({ a: { url_env: 'A', key_env: 'B', forward_brand: 'brand' }, b: { url_env: 'C', key_env: 'D', forward_brand: 'brandSlug' } });
      const b = loadBrandConfig(tmp, 'x');
      expect(forwardBrandKey(b, 'a')).toBe('brand');
      expect(forwardBrandKey(b, 'b')).toBe('brandSlug');
    });

    it.each([['brand_id'], [''], [true], [['brand']], ['BRAND']])('refuses forward_brand %j and names the hand', (bad) => {
      write({ ok: { url_env: 'A', key_env: 'B' }, 'design-module': { url_env: 'A', key_env: 'B', forward_brand: bad } });
      expect(() => loadBrandConfig(tmp, 'x')).toThrow(/hand design-module: forward_brand must be one of brand, brandSlug/);
    });

    it('refuses a hand entry that is not an object', () => {
      write({ 'design-module': 'DESIGN_MODULE_URL' });
      expect(() => loadBrandConfig(tmp, 'x')).toThrow(/hand design-module must be an object/);
    });
  });
});
