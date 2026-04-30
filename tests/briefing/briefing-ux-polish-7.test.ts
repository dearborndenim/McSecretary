/**
 * Briefing UX polish 7 — 2026-04-29.
 *
 * Sub-feature 1: /briefing-preview cache — avoid regenerating identical
 * previews within 5 min for the same (user, sortedSections). In-process cache
 * keyed on canonical key. TTL configurable via BRIEFING_PREVIEW_CACHE_TTL_SECONDS
 * (default 300). Hard opt-out via DISABLE_BRIEFING_PREVIEW_CACHE=1.
 */
import { describe, it, expect } from 'vitest';
import {
  buildBriefingPreviewCache,
  canonicalCacheKey,
  resolveBriefingPreviewCacheTtlSeconds,
  InMemoryBriefingPreviewCache,
  NoopBriefingPreviewCache,
} from '../../src/briefing/preview-cache.js';

// ============================================================================
// Deliverable 1 — /briefing-preview cache
// ============================================================================

describe('Polish 7 — preview cache: canonical key', () => {
  it('sorts sections so call order does not fragment the cache', () => {
    expect(canonicalCacheKey('u1', ['emails', 'calendar', 'stats'])).toBe(
      canonicalCacheKey('u1', ['stats', 'calendar', 'emails']),
    );
  });

  it('treats undefined (default full briefing) distinctly from any explicit list', () => {
    const defaultKey = canonicalCacheKey('u1', undefined);
    const emptyKey = canonicalCacheKey('u1', []);
    expect(defaultKey).not.toEqual(emptyKey);
  });

  it('isolates by user', () => {
    const a = canonicalCacheKey('u1', ['emails']);
    const b = canonicalCacheKey('u2', ['emails']);
    expect(a).not.toEqual(b);
  });

  it('isolates by sections content', () => {
    const a = canonicalCacheKey('u1', ['emails']);
    const b = canonicalCacheKey('u1', ['emails', 'stats']);
    expect(a).not.toEqual(b);
  });
});

describe('Polish 7 — preview cache: miss-then-hit', () => {
  it('returns undefined on first lookup and the stored value on the second', () => {
    const cache = new InMemoryBriefingPreviewCache(300);
    expect(cache.get('u1', ['emails'])).toBeUndefined();
    cache.set('u1', ['emails'], '<rendered>');
    expect(cache.get('u1', ['emails'])).toBe('<rendered>');
    expect(cache.size()).toBe(1);
  });

  it('treats sorted-equivalent section lists as the same cache slot', () => {
    const cache = new InMemoryBriefingPreviewCache(300);
    cache.set('u1', ['emails', 'calendar'], '<rendered>');
    expect(cache.get('u1', ['calendar', 'emails'])).toBe('<rendered>');
  });
});

describe('Polish 7 — preview cache: TTL expiry', () => {
  it('returns undefined once the TTL has elapsed', () => {
    let now = 1_000_000;
    const cache = new InMemoryBriefingPreviewCache(60, () => now);
    cache.set('u1', ['emails'], '<rendered>');
    now += 30_000; // 30s — within TTL
    expect(cache.get('u1', ['emails'])).toBe('<rendered>');
    now += 31_000; // 61s total — past TTL (60s)
    expect(cache.get('u1', ['emails'])).toBeUndefined();
    expect(cache.size()).toBe(0);
  });

  it('evicts only the expired entries, not adjacent live ones', () => {
    let now = 1_000_000;
    const cache = new InMemoryBriefingPreviewCache(60, () => now);
    cache.set('u1', ['emails'], '<a>');
    now += 50_000;
    cache.set('u2', ['emails'], '<b>');
    now += 20_000; // u1 = 70s (expired), u2 = 20s (live)
    expect(cache.get('u1', ['emails'])).toBeUndefined();
    expect(cache.get('u2', ['emails'])).toBe('<b>');
  });
});

describe('Polish 7 — preview cache: key isolation', () => {
  it('does not return a hit for a different user', () => {
    const cache = new InMemoryBriefingPreviewCache(300);
    cache.set('u1', ['emails'], '<rendered-1>');
    expect(cache.get('u2', ['emails'])).toBeUndefined();
  });

  it('does not return a hit for a different section list', () => {
    const cache = new InMemoryBriefingPreviewCache(300);
    cache.set('u1', ['emails'], '<rendered-1>');
    expect(cache.get('u1', ['stats'])).toBeUndefined();
    expect(cache.get('u1', ['emails', 'stats'])).toBeUndefined();
    expect(cache.get('u1', undefined)).toBeUndefined();
  });
});

describe('Polish 7 — preview cache: env factory', () => {
  it('DISABLE_BRIEFING_PREVIEW_CACHE=1 returns a no-op shim that always misses', () => {
    const cache = buildBriefingPreviewCache({ DISABLE_BRIEFING_PREVIEW_CACHE: '1' });
    expect(cache.enabled).toBe(false);
    expect(cache).toBeInstanceOf(NoopBriefingPreviewCache);
    cache.set('u1', ['emails'], '<rendered>');
    expect(cache.get('u1', ['emails'])).toBeUndefined();
    expect(cache.size()).toBe(0);
  });

  it('honors BRIEFING_PREVIEW_CACHE_TTL_SECONDS override', () => {
    expect(resolveBriefingPreviewCacheTtlSeconds({ BRIEFING_PREVIEW_CACHE_TTL_SECONDS: '60' })).toBe(60);
    expect(resolveBriefingPreviewCacheTtlSeconds({ BRIEFING_PREVIEW_CACHE_TTL_SECONDS: '900' })).toBe(900);
    // Invalid / non-positive falls back to default 300.
    expect(resolveBriefingPreviewCacheTtlSeconds({ BRIEFING_PREVIEW_CACHE_TTL_SECONDS: '0' })).toBe(300);
    expect(resolveBriefingPreviewCacheTtlSeconds({ BRIEFING_PREVIEW_CACHE_TTL_SECONDS: '-5' })).toBe(300);
    expect(resolveBriefingPreviewCacheTtlSeconds({ BRIEFING_PREVIEW_CACHE_TTL_SECONDS: 'abc' })).toBe(300);
    expect(resolveBriefingPreviewCacheTtlSeconds({})).toBe(300);
    // Upper bound clamp at 86400.
    expect(resolveBriefingPreviewCacheTtlSeconds({ BRIEFING_PREVIEW_CACHE_TTL_SECONDS: '999999' })).toBe(86400);
  });

  it('default factory returns a real cache when env is empty', () => {
    const cache = buildBriefingPreviewCache({});
    expect(cache.enabled).toBe(true);
    expect(cache).toBeInstanceOf(InMemoryBriefingPreviewCache);
  });

  it('TTL override drives actual eviction timing', () => {
    let now = 1_000_000;
    const cache = buildBriefingPreviewCache(
      { BRIEFING_PREVIEW_CACHE_TTL_SECONDS: '10' },
      () => now,
    );
    cache.set('u1', ['emails'], '<rendered>');
    expect(cache.get('u1', ['emails'])).toBe('<rendered>');
    now += 11_000; // 11s — past the 10s TTL
    expect(cache.get('u1', ['emails'])).toBeUndefined();
  });
});

