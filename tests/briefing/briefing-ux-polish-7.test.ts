/**
 * Briefing UX polish 7 — 2026-04-29.
 *
 * Two sub-features:
 *   1. /briefing-preview cache — avoid regenerating identical previews within
 *      5 min for the same (user, sortedSections). In-process cache keyed on
 *      canonical key. TTL configurable via BRIEFING_PREVIEW_CACHE_TTL_SECONDS
 *      (default 300). Hard opt-out via DISABLE_BRIEFING_PREVIEW_CACHE=1.
 *   2. /briefing-sections audit digest user filter — when
 *      BRIEFING_AUDIT_DIGEST_USERS=alice,bob is set, scope the daily digest to
 *      those users (case-insensitive). Unset / blank → fleet-wide.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import {
  createUser,
  insertBriefingSectionsAudit,
} from '../../src/db/user-queries.js';
import {
  buildBriefingPreviewCache,
  canonicalCacheKey,
  resolveBriefingPreviewCacheTtlSeconds,
  InMemoryBriefingPreviewCache,
  NoopBriefingPreviewCache,
} from '../../src/briefing/preview-cache.js';
import {
  parseAuditDigestUserFilter,
  filterAuditRowsByUsers,
  runBriefingSectionsAuditDigest,
} from '../../src/briefing/sections-audit-digest.js';

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

// ============================================================================
// Deliverable 2 — Audit digest user filter
// ============================================================================

describe('Polish 7 — audit digest: parseAuditDigestUserFilter', () => {
  it('returns undefined when env unset', () => {
    expect(parseAuditDigestUserFilter(undefined)).toBeUndefined();
  });

  it('returns undefined when env is empty / whitespace / no real entries', () => {
    expect(parseAuditDigestUserFilter('')).toBeUndefined();
    expect(parseAuditDigestUserFilter('   ')).toBeUndefined();
    expect(parseAuditDigestUserFilter(',,,')).toBeUndefined();
    expect(parseAuditDigestUserFilter(' , , ,')).toBeUndefined();
  });

  it('returns lower-cased trimmed Set when csv has real entries', () => {
    const f = parseAuditDigestUserFilter(' Alice , BOB ');
    expect(f).toBeDefined();
    expect(f!.has('alice')).toBe(true);
    expect(f!.has('bob')).toBe(true);
    expect(f!.size).toBe(2);
  });
});

describe('Polish 7 — audit digest: filterAuditRowsByUsers', () => {
  const sampleRows = [
    {
      id: 1,
      ts: '2026-04-29T10:00:00Z',
      user_name: 'Alice',
      action: 'set',
      source_user: null,
      sections_json: '["emails"]',
      actor: 'admin',
    },
    {
      id: 2,
      ts: '2026-04-29T11:00:00Z',
      user_name: 'BOB',
      action: 'reset',
      source_user: null,
      sections_json: null,
      actor: 'admin',
    },
    {
      id: 3,
      ts: '2026-04-29T12:00:00Z',
      user_name: 'Carol',
      action: 'set',
      source_user: null,
      sections_json: '["stats"]',
      actor: 'admin',
    },
  ] as const;

  it('returns identity when filter is undefined (fleet-wide)', () => {
    const out = filterAuditRowsByUsers([...sampleRows], undefined);
    expect(out.length).toBe(3);
  });

  it('keeps only rows whose user_name matches the filter (case-insensitive)', () => {
    const filter = parseAuditDigestUserFilter('alice,bob');
    const out = filterAuditRowsByUsers([...sampleRows], filter);
    expect(out.map((r) => r.user_name).sort()).toEqual(['Alice', 'BOB']);
  });

  it('case-insensitive — matches mixed-case env to mixed-case user_name', () => {
    const filter = parseAuditDigestUserFilter('CAROL');
    const out = filterAuditRowsByUsers([...sampleRows], filter);
    expect(out.length).toBe(1);
    expect(out[0]?.user_name).toBe('Carol');
  });
});

describe('Polish 7 — audit digest: runBriefingSectionsAuditDigest end-to-end', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
    createUser(db, {
      id: 'u-alice',
      name: 'Alice',
      email: 'alice@example.com',
      role: 'member',
    });
    createUser(db, {
      id: 'u-bob',
      name: 'Bob',
      email: 'bob@example.com',
      role: 'member',
    });
    createUser(db, {
      id: 'u-carol',
      name: 'Carol',
      email: 'carol@example.com',
      role: 'member',
    });
    const recentTs = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    insertBriefingSectionsAudit(db, {
      ts: recentTs,
      user_name: 'Alice',
      action: 'set',
      sections_json: '["emails"]',
    });
    insertBriefingSectionsAudit(db, {
      ts: recentTs,
      user_name: 'Bob',
      action: 'reset',
      sections_json: null,
    });
    insertBriefingSectionsAudit(db, {
      ts: recentTs,
      user_name: 'Carol',
      action: 'set',
      sections_json: '["stats"]',
    });
  });

  it('env unset → fleet-wide (all 3 rows in digest)', () => {
    const result = runBriefingSectionsAuditDigest(db, { env: {} });
    expect(result.ran).toBe(true);
    expect(result.rowCount).toBe(3);
    expect(result.message).toContain('Alice');
    expect(result.message).toContain('Bob');
    expect(result.message).toContain('Carol');
  });

  it('env set → scoped (only matching users in digest)', () => {
    const result = runBriefingSectionsAuditDigest(db, {
      env: { BRIEFING_AUDIT_DIGEST_USERS: 'Alice,Bob' },
    });
    expect(result.ran).toBe(true);
    expect(result.rowCount).toBe(2);
    expect(result.message).toContain('Alice');
    expect(result.message).toContain('Bob');
    expect(result.message).not.toContain('Carol');
  });

  it('env empty CSV → fleet-wide (treated as unset)', () => {
    const result = runBriefingSectionsAuditDigest(db, {
      env: { BRIEFING_AUDIT_DIGEST_USERS: ',,,' },
    });
    expect(result.ran).toBe(true);
    expect(result.rowCount).toBe(3);
    expect(result.message).toContain('Carol');
  });

  it('env case-insensitive matching against user_name', () => {
    const result = runBriefingSectionsAuditDigest(db, {
      env: { BRIEFING_AUDIT_DIGEST_USERS: 'aLiCe' },
    });
    expect(result.ran).toBe(true);
    expect(result.rowCount).toBe(1);
    expect(result.message).toContain('Alice');
    expect(result.message).not.toContain('Bob');
    expect(result.message).not.toContain('Carol');
  });

  it('env scoped + no matching rows → empty digest, ran=false, reason=empty', () => {
    const result = runBriefingSectionsAuditDigest(db, {
      env: { BRIEFING_AUDIT_DIGEST_USERS: 'Nobody' },
    });
    expect(result.ran).toBe(false);
    expect(result.rowCount).toBe(0);
    expect(result.message).toBeNull();
    expect(result.reason).toBe('empty');
  });
});
