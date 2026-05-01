/**
 * Briefing-preview cache (Briefing UX Polish 7 — 2026-04-29).
 *
 * Avoids regenerating an identical /briefing-preview render for the same
 * (user, sortedSections) within a TTL window (default 5 min). Cache is
 * process-local — no persistence, no cross-instance coordination — fine for
 * our single-process scale.
 *
 * Wired into the `/briefing-preview` handler in `src/index.ts`. On cache hit
 * the stored rendered string is returned verbatim; on miss the handler renders
 * via `runTriage` and stores the result.
 *
 * Env knobs:
 *   - `BRIEFING_PREVIEW_CACHE_TTL_SECONDS`  override TTL (default 300, clamp [1, 86400])
 *   - `DISABLE_BRIEFING_PREVIEW_CACHE=1`    hard opt-out → factory returns a no-op shim
 */

/**
 * Counters + age snapshot returned by `stats()`. Hits/misses are cumulative
 * since process start (no decay). `oldestEntryAgeMs` is the age of the oldest
 * live entry in ms, or `null` when the cache is empty (or the no-op shim).
 *
 * Polish 8 (2026-04-30) — backs the `/admin/briefing-preview-cache-stats`
 * endpoint.
 */
export interface BriefingPreviewCacheStats {
  hits: number;
  misses: number;
  oldestEntryAgeMs: number | null;
}

export interface BriefingPreviewCache {
  /**
   * Look up a previously rendered preview. Returns `undefined` on miss or if
   * the stored entry has aged past the TTL (expired entries are deleted).
   */
  get(userId: string, sections: readonly string[] | undefined): string | undefined;
  /** Store a rendered preview keyed on `(userId, sortedSections)`. */
  set(userId: string, sections: readonly string[] | undefined, rendered: string): void;
  /** Test/debug: drop everything. */
  clear(): void;
  /** Test/debug: number of live (non-expired) entries. */
  size(): number;
  /** Whether this cache is a real cache or the no-op shim (DISABLE=1 path). */
  readonly enabled: boolean;
  /**
   * Configured TTL in seconds — set at construction time, exposed for the
   * stats endpoint so admins don't have to cross-reference the env var.
   * `0` for the no-op shim (no entries ever stored).
   */
  readonly ttlSeconds: number;
  /**
   * Snapshot of cache observability counters. Hits/misses are incremented on
   * every `get()` call (expired entries count as a miss). `oldestEntryAgeMs`
   * walks the live entries to find the oldest `createdAt`. Returns `null`
   * when the cache is empty or this is the no-op shim.
   */
  stats(): BriefingPreviewCacheStats;
}

/**
 * Canonical cache key for `(userId, sections)`. Sections are de-duplicated and
 * sorted ASCII-ascending so call order doesn't fragment the cache. `undefined`
 * (full briefing — no override) maps to a stable sentinel distinct from
 * `--sections=` with an empty list.
 *
 * Pure — exported for unit-testing.
 */
export function canonicalCacheKey(
  userId: string,
  sections: readonly string[] | undefined,
): string {
  if (sections === undefined) {
    return `${userId}::__default__`;
  }
  // De-dupe + sort. Empty list case is preserved as a distinct key.
  const sorted = Array.from(new Set(sections)).slice().sort();
  return `${userId}::${sorted.join(',')}`;
}

interface CacheEntry {
  rendered: string;
  /** Epoch ms when this entry was inserted (used for `oldestEntryAgeMs`). */
  createdAt: number;
  /** Epoch ms when this entry expires. */
  expiresAt: number;
}

/**
 * Default in-memory cache implementation. Single Map keyed on
 * `canonicalCacheKey()`. Lazy expiry — entries are only evicted on access.
 * For our single-process service the leak risk is negligible, but
 * `clear()` is exposed for tests + future ops surfaces.
 */
export class InMemoryBriefingPreviewCache implements BriefingPreviewCache {
  readonly enabled = true;
  readonly ttlSeconds: number;
  private readonly entries = new Map<string, CacheEntry>();
  private readonly ttlMs: number;
  private readonly nowFn: () => number;
  /** Cumulative hit/miss counters since process start. */
  private hits = 0;
  private misses = 0;

  constructor(ttlSeconds: number, nowFn: () => number = () => Date.now()) {
    // Defensive clamp — caller's factory already validates, but if a test
    // passes a bogus value directly we still want a sane bound.
    const safe = Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds : 300;
    const clamped = Math.min(safe, 86400);
    this.ttlSeconds = clamped;
    this.ttlMs = clamped * 1000;
    this.nowFn = nowFn;
  }

  get(userId: string, sections: readonly string[] | undefined): string | undefined {
    const key = canonicalCacheKey(userId, sections);
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    if (entry.expiresAt <= this.nowFn()) {
      // Expired entries count as a miss — the caller will re-render.
      this.entries.delete(key);
      this.misses++;
      return undefined;
    }
    this.hits++;
    return entry.rendered;
  }

  set(userId: string, sections: readonly string[] | undefined, rendered: string): void {
    const key = canonicalCacheKey(userId, sections);
    const now = this.nowFn();
    this.entries.set(key, {
      rendered,
      createdAt: now,
      expiresAt: now + this.ttlMs,
    });
  }

  clear(): void {
    this.entries.clear();
  }

  size(): number {
    // Sweep expired so the count is honest.
    const now = this.nowFn();
    for (const [k, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(k);
    }
    return this.entries.size;
  }

  stats(): BriefingPreviewCacheStats {
    // Walk live entries (post-expiry-sweep) for the min `createdAt`. Sweep
    // first so the age reflects only live entries — an expired-but-not-yet-
    // evicted row should not skew the answer.
    const now = this.nowFn();
    let oldest: number | null = null;
    for (const [k, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(k);
        continue;
      }
      if (oldest === null || entry.createdAt < oldest) {
        oldest = entry.createdAt;
      }
    }
    return {
      hits: this.hits,
      misses: this.misses,
      oldestEntryAgeMs: oldest === null ? null : Math.max(0, now - oldest),
    };
  }
}

/**
 * No-op shim returned when `DISABLE_BRIEFING_PREVIEW_CACHE=1`. `get` always
 * misses; `set` is a no-op. Lets the handler call sites stay branch-free.
 */
export class NoopBriefingPreviewCache implements BriefingPreviewCache {
  readonly enabled = false;
  /** No entries are ever stored, so TTL is irrelevant — surface as 0. */
  readonly ttlSeconds = 0;
  get(): undefined {
    return undefined;
  }
  set(): void {
    /* no-op */
  }
  clear(): void {
    /* no-op */
  }
  size(): number {
    return 0;
  }
  stats(): BriefingPreviewCacheStats {
    // No counters are tracked — the endpoint reflects `disabled:true` so the
    // shape stays uniform with the in-memory case.
    return { hits: 0, misses: 0, oldestEntryAgeMs: null };
  }
}

/**
 * Resolve the effective TTL in seconds. Default 300 (5 min). Invalid /
 * non-positive values fall back to the default. Clamp upper bound at 86400
 * (1 day) to prevent stale-forever entries from a config typo.
 *
 * Exported for tests.
 */
export function resolveBriefingPreviewCacheTtlSeconds(
  env: Record<string, string | undefined>,
): number {
  const raw = env.BRIEFING_PREVIEW_CACHE_TTL_SECONDS;
  if (raw === undefined || raw.trim() === '') return 300;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 300;
  return Math.min(parsed, 86400);
}

/**
 * Factory honoring env-driven config. Returns a `NoopBriefingPreviewCache`
 * when `DISABLE_BRIEFING_PREVIEW_CACHE=1` (so callers don't have to branch).
 */
export function buildBriefingPreviewCache(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
  nowFn: () => number = () => Date.now(),
): BriefingPreviewCache {
  if (env.DISABLE_BRIEFING_PREVIEW_CACHE === '1') {
    return new NoopBriefingPreviewCache();
  }
  const ttl = resolveBriefingPreviewCacheTtlSeconds(env);
  return new InMemoryBriefingPreviewCache(ttl, nowFn);
}
