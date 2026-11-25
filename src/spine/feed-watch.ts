/**
 * Feed watch, the CTO's eyes (spec docs/superpowers/specs/2026-11-25-plan-driven-company-design.md
 * B6, in the claude_code repo). Hourly, each hand in `config/feed-watch.json` is
 * asked for `GET /api/integration/feeds` (contract C1) with its own bearer from the
 * brand file, the same way every server-side hand read does (`readHandPath`). Each
 * feed gets a state in `feed_watch_state`; a feed turning bad files one
 * `grok_task_chief` task (`kind: feed_down`) per run for Chief (Robert, 2026-10-27:
 * alerts go to Chief, never a card); the 05:00 Spine Sweep lists every feed still
 * bad and, once, each feed that recovered in the last 24 h. `GET /spine/feeds`
 * serves the state (contract C2). No card, no approval, no model call.
 *
 * A hand-level row (key `*`) carries the call itself: two consecutive failed calls
 * (network, non-2xx, a body that is not C1, the hand not configured) make the hand
 * `unreachable`; a 404 reads "feeds route not deployed". While a hand is
 * unreachable its feed rows are left as they were and are not listed.
 */
import fs from 'node:fs';
import type Database from 'better-sqlite3';
import { insertEvent } from '../db/event-queries.js';
import { loadBrandConfig } from './brand-config.js';
import { readHandPath } from './hand-read.js';

export type FeedState = 'ok' | 'stale' | 'error' | 'missing' | 'unreachable';
export const HAND_KEY = '*';
export const FEEDS_PATH = '/api/integration/feeds';
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const ERROR_TEXT_MAX = 300;
const UNREACHABLE_AFTER_FAILS = 2;
const SWEEP_LIST_CAP = 15;
const CHIEF_LIST_CAP = 20;
const LAST_RUN_META_KEY = 'feed_watch_last_run';

/** One feed as a hand reports it (C1), after parsing. */
export interface HandFeed {
  key: string;
  label: string | null;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_status: string;
  last_error: string | null;
  expected_every_hours: number | null;
  data_through: string | null;
}

export type HandCallResult = { ok: true; feeds: HandFeed[] } | { ok: false; detail: string };

export interface FeedRow {
  hand: string;
  key: string;
  label: string | null;
  state: FeedState;
  /** Start of the current state; for a bad feed, the start of the bad spell. */
  since: string;
  /** Set when Chief was told about the current bad spell; cleared on recovery. */
  last_alerted_at: string | null;
  detail: string | null;
  last_success_at: string | null;
  last_error: string | null;
  data_through: string | null;
  first_seen_at: string;
  /** Hand row only: consecutive failed calls. */
  fail_count: number;
  recovered_at: string | null;
  checked_at: string;
}

export interface FeedWatchConfig { brand: string; hands: Record<string, { expected: string[] }> }

export function feedWatchEnabled(env: Record<string, string | undefined>): boolean {
  return (env.FEED_WATCH ?? 'on').trim().toLowerCase() !== 'off';
}

export function feedWatchConfigFromEnv(env: Record<string, string | undefined>): string {
  return env.FEED_WATCH_CONFIG ?? 'config/feed-watch.json';
}

export function loadFeedWatchConfig(file: string): FeedWatchConfig {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  const brand = raw.brand;
  const hands = raw.hands;
  if (typeof brand !== 'string' || !brand) throw new Error(`feed-watch: brand missing in ${file}`);
  if (!hands || typeof hands !== 'object' || Array.isArray(hands)) throw new Error(`feed-watch: hands missing in ${file}`);
  const out: FeedWatchConfig = { brand, hands: {} };
  for (const [hand, v] of Object.entries(hands as Record<string, unknown>)) {
    const expected = (v as { expected?: unknown })?.expected;
    if (!Array.isArray(expected) || expected.some((k) => typeof k !== 'string' || !k || k === HAND_KEY)) {
      throw new Error(`feed-watch: hands.${hand}.expected must be a list of feed keys in ${file}`);
    }
    out.hands[hand] = { expected: [...new Set(expected as string[])] };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Parsing C1 (the external boundary): anything off-shape is a failed call.
// ---------------------------------------------------------------------------

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const oneLine = (s: string, max: number): string => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

export function parseFeedsResponse(text: string): HandFeed[] | null {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return null; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const list = (raw as { feeds?: unknown }).feeds;
  if (!Array.isArray(list)) return null;
  const seen = new Set<string>();
  const feeds: HandFeed[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const f = item as Record<string, unknown>;
    const key = str(f.key);
    if (!key || key.length > 100 || key === HAND_KEY || seen.has(key)) continue;
    seen.add(key);
    const hours = f.expected_every_hours;
    const err = str(f.last_error);
    feeds.push({
      key,
      label: str(f.label) ? oneLine(f.label as string, 120) : null,
      last_attempt_at: str(f.last_attempt_at),
      last_success_at: str(f.last_success_at),
      last_status: str(f.last_status) ?? 'never',
      last_error: err ? oneLine(err, ERROR_TEXT_MAX) : null,
      expected_every_hours: typeof hours === 'number' && Number.isFinite(hours) && hours > 0 ? hours : null,
      data_through: str(f.data_through),
    });
  }
  return feeds;
}

// ---------------------------------------------------------------------------
// The state function (pure).
// ---------------------------------------------------------------------------

const ms = (iso: string | null): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

/**
 * One feed's state now. `firstSeenAt` (when the watch first saw the key) stands in
 * for the last success of a feed that has never succeeded, so a feed that has
 * just been deployed is not stale on its first look.
 * - missing: an expected key the hand did not report;
 * - error: last_status `error` and the last success older than expected (or
 *   absent); with no expected interval, judged on the status alone;
 * - stale: expected interval set and now - last success > 2 x expected + 1 h;
 * - ok otherwise (an error with a recent success is ok).
 */
export function judgeFeed(
  feed: HandFeed | undefined, nowIso: string, firstSeenAt: string,
): { state: FeedState; detail: string | null } {
  if (!feed) return { state: 'missing', detail: 'the hand does not report this feed' };
  const now = Date.parse(nowIso);
  const exp = feed.expected_every_hours;
  const lastOk = ms(feed.last_success_at);
  if (feed.last_status === 'error') {
    if (exp === null || lastOk === null || now - lastOk > exp * HOUR_MS) {
      return { state: 'error', detail: feed.last_error ?? 'last run failed' };
    }
  }
  if (exp !== null) {
    const ref = lastOk ?? ms(firstSeenAt) ?? now;
    const age = now - ref;
    if (age > (2 * exp + 1) * HOUR_MS) {
      const h = Math.round(age / HOUR_MS);
      return {
        state: 'stale',
        detail: lastOk !== null
          ? `last success ${h} h ago, expected every ${exp} h`
          : `no success in ${h} h of watching, expected every ${exp} h`,
      };
    }
  }
  return { state: 'ok', detail: null };
}

const isBad = (s: FeedState) => s !== 'ok';

/**
 * Moves a row to its judged state. A bad spell starts when a row leaves ok (or
 * is first seen bad): `since` and `last_alerted_at` are set then and kept while
 * it stays bad, whatever bad state it moves through, so Chief hears once per
 * spell. Back to ok sets `recovered_at` and clears the alert mark.
 */
export function advanceRow(
  prev: FeedRow | undefined,
  base: Pick<FeedRow, 'hand' | 'key'> & Partial<Pick<FeedRow, 'label' | 'last_success_at' | 'last_error' | 'data_through' | 'fail_count'>>,
  judged: { state: FeedState; detail: string | null },
  nowIso: string,
): { row: FeedRow; turnedBad: boolean; recovered: boolean } {
  const wasBad = prev ? isBad(prev.state) : false;
  const nowBad = isBad(judged.state);
  const turnedBad = nowBad && !wasBad;
  const recovered = !nowBad && wasBad;
  const row: FeedRow = {
    hand: base.hand,
    key: base.key,
    label: base.label !== undefined ? base.label : prev?.label ?? null,
    state: judged.state,
    since: !prev || turnedBad || recovered ? nowIso : prev.since,
    last_alerted_at: turnedBad ? nowIso : nowBad ? prev?.last_alerted_at ?? nowIso : null,
    detail: judged.detail,
    last_success_at: base.last_success_at !== undefined ? base.last_success_at : prev?.last_success_at ?? null,
    last_error: base.last_error !== undefined ? base.last_error : prev?.last_error ?? null,
    data_through: base.data_through !== undefined ? base.data_through : prev?.data_through ?? null,
    first_seen_at: prev?.first_seen_at ?? nowIso,
    fail_count: base.fail_count ?? prev?.fail_count ?? 0,
    recovered_at: recovered ? nowIso : prev?.recovered_at ?? null,
    checked_at: nowIso,
  };
  return { row, turnedBad, recovered };
}

export interface RunEvaluation {
  upserts: FeedRow[];
  deletes: Array<{ hand: string; key: string }>;
  turnedBad: FeedRow[];
  recovered: FeedRow[];
}

/** One watch run over every configured hand (pure). */
export function evaluateRun(
  prevRows: FeedRow[], results: Map<string, HandCallResult>, config: FeedWatchConfig, nowIso: string,
): RunEvaluation {
  const prev = new Map(prevRows.map((r) => [`${r.hand}\u0000${r.key}`, r]));
  const out: RunEvaluation = { upserts: [], deletes: [], turnedBad: [], recovered: [] };
  const take = (r: ReturnType<typeof advanceRow>) => {
    out.upserts.push(r.row);
    if (r.turnedBad) out.turnedBad.push(r.row);
    if (r.recovered) out.recovered.push(r.row);
  };
  for (const [hand, { expected }] of Object.entries(config.hands)) {
    const result = results.get(hand);
    if (!result) continue;
    const handPrev = prev.get(`${hand}\u0000${HAND_KEY}`);
    if (!result.ok) {
      const fails = (handPrev?.fail_count ?? 0) + 1;
      if (fails >= UNREACHABLE_AFTER_FAILS) {
        take(advanceRow(handPrev, { hand, key: HAND_KEY, label: 'feeds route', fail_count: fails }, { state: 'unreachable', detail: result.detail }, nowIso));
      } else {
        // First strike: remember it, keep the state the row had.
        const keep = handPrev ? { state: handPrev.state, detail: handPrev.detail } : { state: 'ok' as const, detail: null };
        take(advanceRow(handPrev, { hand, key: HAND_KEY, label: 'feeds route', fail_count: fails }, keep, nowIso));
      }
      continue;
    }
    take(advanceRow(handPrev, { hand, key: HAND_KEY, label: 'feeds route', fail_count: 0 }, { state: 'ok', detail: null }, nowIso));
    const reported = new Map(result.feeds.map((f) => [f.key, f]));
    const keys = [...new Set([...expected, ...reported.keys()])];
    for (const key of keys) {
      const p = prev.get(`${hand}\u0000${key}`);
      const feed = reported.get(key);
      const judged = judgeFeed(feed, nowIso, p?.first_seen_at ?? nowIso);
      take(advanceRow(p, {
        hand, key,
        ...(feed ? {
          label: feed.label ?? p?.label ?? null,
          last_success_at: feed.last_success_at,
          last_error: feed.last_error,
          data_through: feed.data_through,
        } : {}),
      }, judged, nowIso));
    }
    for (const r of prevRows) {
      if (r.hand === hand && r.key !== HAND_KEY && !keys.includes(r.key)) out.deletes.push({ hand, key: r.key });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Views (pure): what is listed, the sweep section, C2, the Chief task.
// ---------------------------------------------------------------------------

/** Rows to show: hand rows only when unreachable; feed rows of an unreachable hand hidden. */
export function visibleRows(rows: FeedRow[]): FeedRow[] {
  const down = new Set(rows.filter((r) => r.key === HAND_KEY && r.state === 'unreachable').map((r) => r.hand));
  return rows
    .filter((r) => (r.key === HAND_KEY ? r.state === 'unreachable' : !down.has(r.hand)))
    .sort((a, b) => a.hand.localeCompare(b.hand) || a.key.localeCompare(b.key));
}

const CT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
export function ctTime(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : CT.format(new Date(t)).replace(',', '');
}

const feedName = (r: FeedRow) => (r.key === HAND_KEY ? `${r.hand} feeds route` : `${r.hand} ${r.key}`);

/** Lines for the 05:00 Spine Sweep; empty when nothing is bad and nothing recovered in 24 h. */
export function formatFeedSection(rows: FeedRow[], nowIso: string): string[] {
  const shown = visibleRows(rows);
  const bad = shown.filter((r) => isBad(r.state));
  const now = Date.parse(nowIso);
  const back = rows.filter((r) => r.state === 'ok' && r.recovered_at !== null
    && now - Date.parse(r.recovered_at) < DAY_MS && Date.parse(r.recovered_at) <= now);
  if (bad.length === 0 && back.length === 0) return [];
  const lines: string[] = [];
  if (bad.length) {
    lines.push(`Feeds: ${bad.length} bad`);
    for (const r of bad.slice(0, SWEEP_LIST_CAP)) {
      const label = r.label && r.key !== HAND_KEY ? ` (${r.label})` : '';
      const lastOk = r.last_success_at && r.key !== HAND_KEY ? `; last ok ${ctTime(r.last_success_at)}` : '';
      lines.push(`  ${feedName(r)}${label}: ${r.state} since ${ctTime(r.since)}${r.detail ? ` — ${r.detail}` : ''}${lastOk}`);
    }
    if (bad.length > SWEEP_LIST_CAP) lines.push(`  …and ${bad.length - SWEEP_LIST_CAP} more`);
  }
  for (const r of back.sort((a, b) => a.hand.localeCompare(b.hand) || a.key.localeCompare(b.key))) {
    lines.push(`Feed recovered: ${feedName(r)} at ${ctTime(r.recovered_at!)}`);
  }
  return lines;
}

export interface FeedsView {
  as_of: string | null;
  ok: boolean;
  feeds: Array<{
    hand: string; key: string; label: string | null; state: FeedState; since: string;
    last_success_at: string | null; last_error: string | null; data_through: string | null; detail: string | null;
  }>;
}

/** C2. `detail` is additive: why a feed is bad (the reason for missing / unreachable / stale). */
export function buildFeedsView(rows: FeedRow[], asOf: string | null): FeedsView {
  const feeds = visibleRows(rows).map((r) => ({
    hand: r.hand, key: r.key, label: r.label, state: r.state, since: r.since,
    last_success_at: r.last_success_at, last_error: r.last_error, data_through: r.data_through, detail: r.detail,
  }));
  return { as_of: asOf, ok: feeds.every((f) => f.state === 'ok'), feeds };
}

/** The `grok_task_chief` payload for the feeds that turned bad in one run. */
export function feedDownTask(turnedBad: FeedRow[], nowIso: string): Record<string, unknown> {
  const shown = turnedBad.slice(0, CHIEF_LIST_CAP);
  const lines = shown.map((r) => `${feedName(r)}${r.label && r.key !== HAND_KEY ? ` (${r.label})` : ''}: ${r.state}${r.detail ? ` — ${r.detail}` : ''}`);
  if (turnedBad.length > shown.length) lines.push(`…and ${turnedBad.length - shown.length} more`);
  const n = turnedBad.length;
  return {
    task_id: `feed-down-${nowIso.replace(/\D/g, '').slice(0, 14)}`,
    kind: 'feed_down',
    args: {
      for: 'chief',
      message: `${n} data feed${n === 1 ? '' : 's'} stopped working. Tell Robert in Grok; the numbers that depend on ${n === 1 ? 'it' : 'them'} are no longer current. You will not be told again until ${n === 1 ? 'it recovers' : 'each recovers'} and fails again.`,
      lines,
      feeds: shown.map((r) => ({
        hand: r.hand, key: r.key, label: r.label, state: r.state, since: r.since,
        last_error: r.last_error, detail: r.detail, last_success_at: r.last_success_at,
      })),
    },
    notify: false, due: null, filed_by: 'mcsecretary', reply_type: null,
  };
}

// ---------------------------------------------------------------------------
// Storage and the job.
// ---------------------------------------------------------------------------

export function listFeedRows(db: Database.Database): FeedRow[] {
  return db.prepare('SELECT * FROM feed_watch_state ORDER BY hand, key').all() as FeedRow[];
}

export function feedWatchLastRun(db: Database.Database): string | null {
  const r = db.prepare('SELECT value FROM spine_meta WHERE key = ?').get(LAST_RUN_META_KEY) as { value: string } | undefined;
  return r?.value ?? null;
}

/** Writes one run and, when a feed turned bad, files the Chief task; returns its event id or null. */
export function saveRun(db: Database.Database, ev: RunEvaluation, nowIso: string): number | null {
  const upsert = db.prepare(`
    INSERT INTO feed_watch_state (hand, key, label, state, since, last_alerted_at, detail, last_success_at,
      last_error, data_through, first_seen_at, fail_count, recovered_at, checked_at)
    VALUES (@hand, @key, @label, @state, @since, @last_alerted_at, @detail, @last_success_at,
      @last_error, @data_through, @first_seen_at, @fail_count, @recovered_at, @checked_at)
    ON CONFLICT (hand, key) DO UPDATE SET label = excluded.label, state = excluded.state, since = excluded.since,
      last_alerted_at = excluded.last_alerted_at, detail = excluded.detail, last_success_at = excluded.last_success_at,
      last_error = excluded.last_error, data_through = excluded.data_through, first_seen_at = excluded.first_seen_at,
      fail_count = excluded.fail_count, recovered_at = excluded.recovered_at, checked_at = excluded.checked_at
  `);
  const del = db.prepare('DELETE FROM feed_watch_state WHERE hand = ? AND key = ?');
  return db.transaction(() => {
    for (const r of ev.upserts) upsert.run(r);
    for (const d of ev.deletes) del.run(d.hand, d.key);
    db.prepare('INSERT INTO spine_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
      .run(LAST_RUN_META_KEY, nowIso);
    if (ev.turnedBad.length === 0) return null;
    return insertEvent(db, {
      source_hand: 'mcsecretary', brand_id: 'dearborn-denim', event_type: 'grok_task_chief', urgent: false,
      payload: feedDownTask(ev.turnedBad, nowIso),
    }, nowIso);
  })();
}

export interface FeedWatchDeps {
  db: Database.Database;
  nowIso: string;
  env: Record<string, string | undefined>;
  brandsDir: string;
  config: FeedWatchConfig;
  /** Owns the timeout, like the spine's handFetch. */
  handFetch: (url: string, init: RequestInit) => Promise<Response>;
}

export async function callHandFeeds(deps: FeedWatchDeps, hand: string): Promise<HandCallResult> {
  try {
    const brand = loadBrandConfig(deps.brandsDir, deps.config.brand);
    const r = await readHandPath({ brand, hand, path: FEEDS_PATH, env: deps.env, handFetch: deps.handFetch });
    if (!r.ok) return { ok: false, detail: `hand not configured: ${oneLine(r.error, 200)}` };
    if (r.status === 404) return { ok: false, detail: 'feeds route not deployed' };
    if (r.status < 200 || r.status >= 300) return { ok: false, detail: `feeds route answered HTTP ${r.status}` };
    const feeds = parseFeedsResponse(r.text);
    if (!feeds) return { ok: false, detail: 'feeds route answered something that is not a feeds list' };
    return { ok: true, feeds };
  } catch (err) {
    return { ok: false, detail: `call failed: ${oneLine(err instanceof Error ? err.message : String(err), 200)}` };
  }
}

/** The hourly job: call every hand, judge, store, alert Chief once per bad spell. */
export async function runFeedWatch(deps: FeedWatchDeps): Promise<{ eventId: number | null; turnedBad: number; recovered: number }> {
  const hands = Object.keys(deps.config.hands);
  const settled = await Promise.all(hands.map(async (h) => [h, await callHandFeeds(deps, h)] as const));
  const ev = evaluateRun(listFeedRows(deps.db), new Map(settled), deps.config, deps.nowIso);
  const eventId = saveRun(deps.db, ev, deps.nowIso);
  return { eventId, turnedBad: ev.turnedBad.length, recovered: ev.recovered.length };
}
