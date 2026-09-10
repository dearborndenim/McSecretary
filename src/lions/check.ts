/**
 * The check itself: fetch the CPS sheet, diff the Lions' games against the last
 * stored snapshot, alert Robert once per change set.
 *
 * Fails closed. Any network, HTTP, parse or sanity problem returns
 * `{ ok: false, error }` WITHOUT writing a snapshot, so a bad fetch can never
 * be read later as "CPS deleted all six games".
 */

import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { lionsConfig, lionsCsvUrl, type LionsConfig } from './config.js';
import { displayTeamName, parseNetworkSheet, type LionsGame } from './parse.js';
import { diffSchedules, formatChangeLine, type ScheduleChange } from './diff.js';
import { addAlerts, getLatestSnapshot, saveSnapshot } from './store.js';

const FETCH_TIMEOUT_MS = 10_000;
/** Below this many parsed games we distrust the sheet if we used to have more. */
const MIN_TRUSTED_GAMES = 3;
/** …and "more" means at least this many in the previous snapshot. */
const PREV_GAMES_FOR_GUARD = 6;

export interface LionsCheckOptions {
  db: Database.Database;
  /** Injected in tests; defaults to global fetch. */
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Injected in tests; defaults to a Telegram message to Robert. */
  notify?: (text: string) => Promise<void>;
  now?: () => Date;
  env?: Record<string, string | undefined>;
}

export type LionsCheckResult =
  | { ok: false; error: string }
  | {
      ok: true;
      /** First-ever run: snapshot stored, nothing alerted. */
      baseline: boolean;
      /** The sheet's bytes differed from the last snapshot. */
      sheetChanged: boolean;
      snapshotSaved: boolean;
      changes: ScheduleChange[];
      notified: boolean;
      games: number;
      checkedAt: string;
    };

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** `2026-10-17` → `Sat 10/17`. Returns '' for an unparseable date. */
export function dateStamp(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return '';
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(d.getTime())) return '';
  return `${WEEKDAYS[d.getUTCDay()]} ${Number(m[2])}/${Number(m[3])}`;
}

/**
 * The Telegram message. One message per check, however many changes: first line
 * is the alarm, then one line per change, then the live page.
 */
export function buildAlertMessage(
  changes: ScheduleChange[],
  games: LionsGame[],
  prevGames: LionsGame[],
  baseUrl: string,
): string {
  const byWeek = new Map(games.map((g) => [g.week, g]));
  const prevByWeek = new Map(prevGames.map((g) => [g.week, g]));
  const lines = ['SCHEDULE CHANGE — South Loop Lions'];
  for (const c of changes) {
    const game = byWeek.get(c.week) ?? prevByWeek.get(c.week);
    lines.push(formatChangeLine(c, game ? dateStamp(game.date) : undefined));
  }
  if (baseUrl) lines.push(`Live page: ${baseUrl}/lions`);
  return lines.join('\n');
}

/** Chicago-local `Sep 9, 6:00 PM` for an ISO timestamp. */
function centralTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

/** The `/lions` Telegram reply: the stored schedule plus any active alerts. */
export function formatScheduleForTelegram(
  games: LionsGame[],
  alerts: { summary: string }[],
  checkedAt: string | null,
  baseUrl: string,
): string {
  const lines = ['South Loop Lions — schedule'];
  if (games.length === 0) {
    lines.push('No games stored yet. Run the check to load the CPS sheet.');
  } else {
    for (const g of [...games].sort((a, b) => a.week - b.week)) {
      const side = g.isHome ? 'vs' : 'at';
      const opponent = displayTeamName(g.opponent);
      const stamp = dateStamp(g.date) || g.date;
      lines.push(`Wk ${g.week} · ${stamp} ${g.time} ${side} ${opponent}${g.venue ? ` — ${g.venue}` : ''}`);
    }
  }
  if (alerts.length > 0) {
    lines.push('', `Active alerts (${alerts.length}):`);
    for (const a of alerts) lines.push(`- ${a.summary}`);
  } else {
    lines.push('', 'No active schedule-change alerts.');
  }
  if (checkedAt) lines.push('', `Checked ${centralTime(checkedAt)} CT`);
  if (baseUrl) lines.push(`Live page: ${baseUrl}/lions`);
  return lines.join('\n');
}

async function fetchCsv(
  url: string,
  doFetch: (url: string, init?: RequestInit) => Promise<Response>,
): Promise<{ ok: true; csv: string } | { ok: false; error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await doFetch(url, {
      signal: controller.signal,
      headers: { Accept: 'text/csv' },
      redirect: 'follow',
    });
    if (!res.ok) return { ok: false, error: `CPS sheet returned HTTP ${res.status}` };
    const csv = await res.text();
    return { ok: true, csv };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `CPS sheet fetch failed: ${msg}` };
  } finally {
    clearTimeout(timer);
  }
}

async function defaultNotify(text: string): Promise<void> {
  const { sendMessage } = await import('../telegram/bot.js');
  // Plain text: team names and arrows must not be re-parsed as Markdown.
  await sendMessage(text, false);
}

export async function runLionsCheck(opts: LionsCheckOptions): Promise<LionsCheckResult> {
  const { db } = opts;
  const cfg: LionsConfig = lionsConfig(opts.env ?? process.env);
  const doFetch = opts.fetch ?? ((url: string, init?: RequestInit) => fetch(url, init));
  const notify = opts.notify ?? defaultNotify;
  const checkedAt = (opts.now ? opts.now() : new Date()).toISOString();
  const url = lionsCsvUrl(cfg);

  const fetched = await fetchCsv(url, doFetch);
  if (!fetched.ok) {
    console.error(`Lions check: ${fetched.error}`);
    return { ok: false, error: fetched.error };
  }

  const sourceHash = crypto.createHash('sha256').update(fetched.csv).digest('hex');
  const prev = getLatestSnapshot(db);

  if (prev && prev.source_hash === sourceHash) {
    return {
      ok: true, baseline: false, sheetChanged: false, snapshotSaved: false,
      changes: [], notified: false, games: prev.games.length, checkedAt,
    };
  }

  let games: LionsGame[];
  try {
    const parsed = parseNetworkSheet(fetched.csv, cfg.team);
    games = parsed.games.map((g) => (g.venue ? g : { ...g, venue: cfg.venue }));
  } catch (err) {
    const error = `CPS sheet parse failed: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`Lions check: ${error}`);
    return { ok: false, error };
  }

  // Sanity gate. A truncated or half-rendered export must not read as removals.
  if (games.length < MIN_TRUSTED_GAMES && prev && prev.games.length >= PREV_GAMES_FOR_GUARD) {
    const error = `CPS sheet looks truncated: parsed ${games.length} ${cfg.team} games, previous snapshot had ${prev.games.length}`;
    console.error(`Lions check: ${error}`);
    return { ok: false, error };
  }
  if (games.length === 0 && !prev) {
    const error = `CPS sheet had no ${cfg.team} games — refusing to store an empty baseline`;
    console.error(`Lions check: ${error}`);
    return { ok: false, error };
  }

  if (!prev) {
    saveSnapshot(db, games, sourceHash, checkedAt);
    console.log(`Lions check: stored baseline with ${games.length} games`);
    return {
      ok: true, baseline: true, sheetChanged: true, snapshotSaved: true,
      changes: [], notified: false, games: games.length, checkedAt,
    };
  }

  const changes = diffSchedules(prev.games, games);
  saveSnapshot(db, games, sourceHash, checkedAt);

  if (changes.length === 0) {
    // The sheet moved (another team's game, a score, a typo) but ours did not.
    console.log('Lions check: sheet changed, no Lions games affected');
    return {
      ok: true, baseline: false, sheetChanged: true, snapshotSaved: true,
      changes: [], notified: false, games: games.length, checkedAt,
    };
  }

  addAlerts(db, changes, checkedAt);
  const message = buildAlertMessage(changes, games, prev.games, cfg.baseUrl);
  let notified = false;
  try {
    await notify(message);
    notified = true;
  } catch (err) {
    // The alerts are already recorded and the page will show them; a Telegram
    // outage must not fail the check.
    console.error(`Lions check: Telegram notify failed — ${err instanceof Error ? err.message : String(err)}`);
  }
  console.log(`Lions check: ${changes.length} change(s) detected, notified=${notified}`);
  return {
    ok: true, baseline: false, sheetChanged: true, snapshotSaved: true,
    changes, notified, games: games.length, checkedAt,
  };
}
