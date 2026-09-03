import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { loadBrandConfig, resolveHand, listBrandIds } from '../../src/spine/brand-config.js';

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
});
