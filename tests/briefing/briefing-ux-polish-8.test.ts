/**
 * Briefing UX polish 8 — 2026-04-30.
 *
 * Two sub-features:
 *   1. /admin/briefing-preview-cache-stats endpoint backed by new
 *      `BriefingPreviewCache.stats()` method on the Polish-7 cache. Counters
 *      (hits/misses), oldest-entry age, ttl, size, disabled flag.
 *   2. Audit digest revert filter via `BRIEFING_AUDIT_DIGEST_INCLUDE_REVERTS=0`
 *      env knob — drops `action='revert'` rows from the daily 7 AM CT digest
 *      so reverts don't dominate the fleet-wide payload.
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
  InMemoryBriefingPreviewCache,
  NoopBriefingPreviewCache,
} from '../../src/briefing/preview-cache.js';
import {
  buildBriefingPreviewCacheStatsPayload,
} from '../../src/api.js';
import {
  filterAuditRowsExcludingReverts,
  shouldIncludeRevertsInDigest,
  runBriefingSectionsAuditDigest,
  formatBriefingSectionsAuditDigest,
} from '../../src/briefing/sections-audit-digest.js';

// ============================================================================
// Deliverable 1 — preview cache stats
// ============================================================================

describe('Polish 8 — preview cache stats: hit/miss counters', () => {
  it('increments misses on first lookup and hits on subsequent lookups', () => {
    const cache = new InMemoryBriefingPreviewCache(300);
    expect(cache.stats()).toEqual({ hits: 0, misses: 0, oldestEntryAgeMs: null });
    // First lookup → miss.
    cache.get('u1', ['emails']);
    expect(cache.stats().misses).toBe(1);
    expect(cache.stats().hits).toBe(0);
    // Set + lookup → hit.
    cache.set('u1', ['emails'], '<rendered>');
    cache.get('u1', ['emails']);
    expect(cache.stats().hits).toBe(1);
    expect(cache.stats().misses).toBe(1);
    // Second hit → hit count grows, misses unchanged.
    cache.get('u1', ['emails']);
    expect(cache.stats().hits).toBe(2);
    expect(cache.stats().misses).toBe(1);
  });

  it('counts expired-entry lookups as a miss (not a hit)', () => {
    let now = 1_000_000;
    const cache = new InMemoryBriefingPreviewCache(60, () => now);
    cache.set('u1', ['emails'], '<rendered>');
    cache.get('u1', ['emails']); // hit
    expect(cache.stats().hits).toBe(1);
    now += 61_000; // past TTL
    cache.get('u1', ['emails']); // miss (expired)
    expect(cache.stats().misses).toBe(1);
    expect(cache.stats().hits).toBe(1);
  });
});

describe('Polish 8 — preview cache stats: oldestEntryAgeMs', () => {
  it('returns null when cache is empty', () => {
    const cache = new InMemoryBriefingPreviewCache(300);
    expect(cache.stats().oldestEntryAgeMs).toBeNull();
  });

  it('tracks the age of the oldest live entry through TTL expiry', () => {
    let now = 1_000_000;
    const cache = new InMemoryBriefingPreviewCache(60, () => now);
    cache.set('u1', ['emails'], '<a>'); // age 0
    now += 10_000;
    cache.set('u2', ['emails'], '<b>'); // age 0
    now += 5_000;
    // u1 is older (15s) than u2 (5s) → oldest age is 15000ms.
    expect(cache.stats().oldestEntryAgeMs).toBe(15_000);
    // Now expire u1 (TTL=60s, u1 was inserted at 1_000_000, so expires at 1_060_000).
    now = 1_061_000;
    // After u1 expires, u2 (createdAt=1_010_000) is the oldest live entry.
    // u2 age = 1_061_000 - 1_010_000 = 51_000.
    expect(cache.stats().oldestEntryAgeMs).toBe(51_000);
    // Now expire u2 too.
    now = 1_071_000;
    expect(cache.stats().oldestEntryAgeMs).toBeNull();
  });
});

describe('Polish 8 — preview cache stats: NoopBriefingPreviewCache', () => {
  it('returns zeroed stats and disabled=true via payload helper', () => {
    const cache = new NoopBriefingPreviewCache();
    expect(cache.stats()).toEqual({ hits: 0, misses: 0, oldestEntryAgeMs: null });
    expect(cache.ttlSeconds).toBe(0);
    expect(cache.enabled).toBe(false);
    const payload = buildBriefingPreviewCacheStatsPayload(cache);
    expect(payload).toEqual({
      size: 0,
      ttl_seconds: 0,
      hits: 0,
      misses: 0,
      oldest_entry_age_seconds: null,
      disabled: true,
    });
  });

  it('built via DISABLE_BRIEFING_PREVIEW_CACHE=1 env reflects disabled:true', () => {
    const cache = buildBriefingPreviewCache({ DISABLE_BRIEFING_PREVIEW_CACHE: '1' });
    const payload = buildBriefingPreviewCacheStatsPayload(cache);
    expect(payload.disabled).toBe(true);
    expect(payload.ttl_seconds).toBe(0);
  });
});

describe('Polish 8 — preview cache stats: payload helper', () => {
  it('returns disabled=true when no cache is wired (provider returns undefined)', () => {
    const payload = buildBriefingPreviewCacheStatsPayload(undefined);
    expect(payload).toEqual({
      size: 0,
      ttl_seconds: 0,
      hits: 0,
      misses: 0,
      oldest_entry_age_seconds: null,
      disabled: true,
    });
  });

  it('exposes ttl_seconds from the configured value at construction', () => {
    const cache = buildBriefingPreviewCache({ BRIEFING_PREVIEW_CACHE_TTL_SECONDS: '120' });
    const payload = buildBriefingPreviewCacheStatsPayload(cache);
    expect(payload.ttl_seconds).toBe(120);
    expect(payload.disabled).toBe(false);
  });

  it('floors oldest_entry_age_seconds from ms', () => {
    let now = 1_000_000;
    const cache = new InMemoryBriefingPreviewCache(300, () => now);
    cache.set('u1', ['emails'], '<r>');
    now += 1_999; // 1.999s — should floor to 1
    const payload = buildBriefingPreviewCacheStatsPayload(cache);
    expect(payload.oldest_entry_age_seconds).toBe(1);
  });

  it('reports counters + size together', () => {
    const cache = new InMemoryBriefingPreviewCache(300);
    cache.get('u1', ['emails']); // miss
    cache.set('u1', ['emails'], '<r>');
    cache.get('u1', ['emails']); // hit
    cache.get('u1', ['emails']); // hit
    const payload = buildBriefingPreviewCacheStatsPayload(cache);
    expect(payload.hits).toBe(2);
    expect(payload.misses).toBe(1);
    expect(payload.size).toBe(1);
    expect(payload.disabled).toBe(false);
    expect(payload.oldest_entry_age_seconds).not.toBeNull();
  });
});

// ============================================================================
// Deliverable 2 — Audit digest revert filter
// ============================================================================

describe('Polish 8 — audit digest: shouldIncludeRevertsInDigest', () => {
  it('defaults to true when env unset', () => {
    expect(shouldIncludeRevertsInDigest({})).toBe(true);
  });

  it('returns false only on the literal string "0"', () => {
    expect(shouldIncludeRevertsInDigest({ BRIEFING_AUDIT_DIGEST_INCLUDE_REVERTS: '0' })).toBe(false);
    expect(shouldIncludeRevertsInDigest({ BRIEFING_AUDIT_DIGEST_INCLUDE_REVERTS: '1' })).toBe(true);
    expect(shouldIncludeRevertsInDigest({ BRIEFING_AUDIT_DIGEST_INCLUDE_REVERTS: '' })).toBe(true);
    expect(shouldIncludeRevertsInDigest({ BRIEFING_AUDIT_DIGEST_INCLUDE_REVERTS: 'true' })).toBe(true);
    expect(shouldIncludeRevertsInDigest({ BRIEFING_AUDIT_DIGEST_INCLUDE_REVERTS: 'false' })).toBe(true);
  });
});

describe('Polish 8 — audit digest: filterAuditRowsExcludingReverts', () => {
  it('drops only revert rows, preserves order otherwise', () => {
    const rows = [
      { id: 1, ts: 't1', user_name: 'A', action: 'set', source_user: null, sections_json: '["x"]', actor: 'a' },
      { id: 2, ts: 't2', user_name: 'B', action: 'revert', source_user: null, sections_json: null, actor: 'a' },
      { id: 3, ts: 't3', user_name: 'C', action: 'reset', source_user: null, sections_json: null, actor: 'a' },
      { id: 4, ts: 't4', user_name: 'D', action: 'revert', source_user: 'audit:1', sections_json: '["x"]', actor: 'a' },
    ];
    const out = filterAuditRowsExcludingReverts(rows);
    expect(out.map((r) => r.user_name)).toEqual(['A', 'C']);
  });

  it('returns empty list when all rows are reverts', () => {
    const rows = [
      { id: 1, ts: 't1', user_name: 'A', action: 'revert', source_user: null, sections_json: null, actor: 'a' },
      { id: 2, ts: 't2', user_name: 'B', action: 'revert', source_user: null, sections_json: null, actor: 'a' },
    ];
    expect(filterAuditRowsExcludingReverts(rows)).toEqual([]);
  });
});

describe('Polish 8 — audit digest: end-to-end with revert filter', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
    createUser(db, { id: 'u-alice', name: 'Alice', email: 'alice@example.com', role: 'member' });
    createUser(db, { id: 'u-bob', name: 'Bob', email: 'bob@example.com', role: 'member' });
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
      action: 'revert',
      source_user: 'audit:1',
      sections_json: null,
    });
    insertBriefingSectionsAudit(db, {
      ts: recentTs,
      user_name: 'Alice',
      action: 'revert',
      source_user: 'audit:2',
      sections_json: '["emails"]',
    });
  });

  it('default (env unset) — includes revert rows', () => {
    const result = runBriefingSectionsAuditDigest(db, { env: {} });
    expect(result.ran).toBe(true);
    expect(result.rowCount).toBe(3);
    expect(result.message).toContain('revert');
    expect(result.message).toContain('Bob');
  });

  it('env=1 — explicit include, behavior identical to unset', () => {
    const result = runBriefingSectionsAuditDigest(db, {
      env: { BRIEFING_AUDIT_DIGEST_INCLUDE_REVERTS: '1' },
    });
    expect(result.ran).toBe(true);
    expect(result.rowCount).toBe(3);
    expect(result.message).toContain('revert');
  });

  it('env=0 — drops revert rows from digest', () => {
    const result = runBriefingSectionsAuditDigest(db, {
      env: { BRIEFING_AUDIT_DIGEST_INCLUDE_REVERTS: '0' },
    });
    expect(result.ran).toBe(true);
    expect(result.rowCount).toBe(1); // only the set
    expect(result.message).toContain('Alice');
    // The revert section header itself must not appear.
    expect(result.message).not.toMatch(/revert \(/);
    expect(result.message).not.toContain('Bob'); // only revert by Bob
  });

  it('"By action:" breakdown omits revert=N when reverts are filtered', () => {
    const result = runBriefingSectionsAuditDigest(db, {
      env: { BRIEFING_AUDIT_DIGEST_INCLUDE_REVERTS: '0' },
    });
    expect(result.message).toContain('By action: set=1');
    expect(result.message).not.toMatch(/revert=\d/);
  });

  it('"By action:" breakdown still shows revert=N when reverts are included', () => {
    const result = runBriefingSectionsAuditDigest(db, {
      env: { BRIEFING_AUDIT_DIGEST_INCLUDE_REVERTS: '1' },
    });
    expect(result.message).toMatch(/revert=2/);
  });

  it('env=0 + only revert rows in window → empty digest, ran=false', () => {
    // Clear non-revert rows and re-test.
    db.prepare("DELETE FROM briefing_sections_audit WHERE action <> 'revert'").run();
    const result = runBriefingSectionsAuditDigest(db, {
      env: { BRIEFING_AUDIT_DIGEST_INCLUDE_REVERTS: '0' },
    });
    expect(result.ran).toBe(false);
    expect(result.rowCount).toBe(0);
    expect(result.message).toBeNull();
    expect(result.reason).toBe('empty');
  });

  it('user-filter then revert-filter compose: scoped + no reverts', () => {
    const result = runBriefingSectionsAuditDigest(db, {
      env: {
        BRIEFING_AUDIT_DIGEST_USERS: 'Alice',
        BRIEFING_AUDIT_DIGEST_INCLUDE_REVERTS: '0',
      },
    });
    expect(result.ran).toBe(true);
    expect(result.rowCount).toBe(1); // Alice's set only
    expect(result.message).toContain('Alice');
    expect(result.message).not.toContain('Bob');
    expect(result.message).not.toMatch(/revert \(/);
  });
});

describe('Polish 8 — formatBriefingSectionsAuditDigest direct invocation', () => {
  it('renders "By action:" with all five action types when present', () => {
    const rows = [
      { id: 1, ts: 't1', user_name: 'A', action: 'set' as const, source_user: null, sections_json: '["x"]', actor: 'a' },
      { id: 2, ts: 't2', user_name: 'B', action: 'reset' as const, source_user: null, sections_json: null, actor: 'a' },
      { id: 3, ts: 't3', user_name: 'C', action: 'revert' as const, source_user: 'audit:1', sections_json: null, actor: 'a' },
    ];
    const msg = formatBriefingSectionsAuditDigest(rows, 24);
    expect(msg).toContain('By action: set=1, reset=1, revert=1');
  });
});

// ============================================================================
// Deliverable 1 — admin endpoint auth check (manual smoke)
// ============================================================================

describe('Polish 8 — admin endpoint: authorization smoke', () => {
  // The HTTP handler is wired in startApiServer(); rather than spin up a real
  // server in unit tests, we verify the underlying payload helper directly
  // (the auth check is a literal `Bearer ${secret}` compare in api.ts).
  // This test confirms the helper is reachable and the contract holds.

  it('payload helper returns expected JSON shape for live cache', () => {
    const cache = new InMemoryBriefingPreviewCache(300);
    cache.set('u1', ['emails'], '<r>');
    cache.get('u1', ['emails']); // hit
    cache.get('u2', ['stats']);  // miss
    const payload = buildBriefingPreviewCacheStatsPayload(cache);
    expect(Object.keys(payload).sort()).toEqual([
      'disabled',
      'hits',
      'misses',
      'oldest_entry_age_seconds',
      'size',
      'ttl_seconds',
    ]);
    expect(typeof payload.size).toBe('number');
    expect(typeof payload.ttl_seconds).toBe('number');
    expect(typeof payload.hits).toBe('number');
    expect(typeof payload.misses).toBe('number');
    expect(typeof payload.disabled).toBe('boolean');
    expect(payload.oldest_entry_age_seconds === null || typeof payload.oldest_entry_age_seconds === 'number').toBe(true);
  });
});
