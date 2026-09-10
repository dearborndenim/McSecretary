/**
 * Storage for the Lions schedule checker: one snapshot per observed version of
 * the sheet, one alert row per detected change.
 *
 * `initializeLionsSchema` is called from `src/db/schema.ts` alongside the other
 * schema initializers and is idempotent (CREATE TABLE IF NOT EXISTS).
 */

import type Database from 'better-sqlite3';
import type { LionsGame } from './parse.js';
import type { ScheduleChange } from './diff.js';

export interface LionsSnapshot {
  id: number;
  taken_at: string;
  games: LionsGame[];
  source_hash: string;
}

export interface LionsAlertRow {
  id: number;
  created_at: string;
  week: number;
  opponent: string;
  kind: string;
  summary: string;
  before: string | null;
  after: string | null;
  cleared_at: string | null;
}

interface RawAlertRow {
  id: number;
  created_at: string;
  week: number;
  opponent: string;
  kind: string;
  summary: string;
  before_json: string | null;
  after_json: string | null;
  cleared_at: string | null;
}

export function initializeLionsSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lions_schedule_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      taken_at TEXT NOT NULL,
      games_json TEXT NOT NULL,
      source_hash TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_lions_snapshots_taken ON lions_schedule_snapshots(taken_at);

    CREATE TABLE IF NOT EXISTS lions_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      week INTEGER NOT NULL,
      opponent TEXT NOT NULL,
      kind TEXT NOT NULL,
      summary TEXT NOT NULL,
      before_json TEXT,
      after_json TEXT,
      cleared_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_lions_alerts_active ON lions_alerts(cleared_at, id);
  `);
}

function parseGames(json: string): LionsGame[] {
  const parsed = JSON.parse(json) as unknown;
  return Array.isArray(parsed) ? (parsed as LionsGame[]) : [];
}

/** Newest snapshot, or null when the checker has never run. */
export function getLatestSnapshot(db: Database.Database): LionsSnapshot | null {
  const row = db.prepare(
    'SELECT id, taken_at, games_json, source_hash FROM lions_schedule_snapshots ORDER BY id DESC LIMIT 1',
  ).get() as { id: number; taken_at: string; games_json: string; source_hash: string } | undefined;
  if (!row) return null;
  return { id: row.id, taken_at: row.taken_at, games: parseGames(row.games_json), source_hash: row.source_hash };
}

export function saveSnapshot(
  db: Database.Database,
  games: LionsGame[],
  sourceHash: string,
  nowIso: string,
): number {
  const r = db.prepare(
    'INSERT INTO lions_schedule_snapshots (taken_at, games_json, source_hash) VALUES (?, ?, ?)',
  ).run(nowIso, JSON.stringify(games), sourceHash);
  return Number(r.lastInsertRowid);
}

/** Record one row per change. Returns the new alert ids in the order given. */
export function addAlerts(db: Database.Database, changes: ScheduleChange[], nowIso: string): number[] {
  const stmt = db.prepare(`
    INSERT INTO lions_alerts (created_at, week, opponent, kind, summary, before_json, after_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const ids: number[] = [];
  const insertAll = db.transaction((rows: ScheduleChange[]) => {
    for (const c of rows) {
      const r = stmt.run(
        nowIso,
        c.week,
        c.opponent,
        c.kind,
        c.summary,
        c.before === null ? null : JSON.stringify(c.before),
        c.after === null ? null : JSON.stringify(c.after),
      );
      ids.push(Number(r.lastInsertRowid));
    }
  });
  insertAll(changes);
  return ids;
}

function hydrate(row: RawAlertRow): LionsAlertRow {
  const decode = (v: string | null): string | null => {
    if (v === null) return null;
    try {
      const parsed = JSON.parse(v) as unknown;
      return typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
    } catch {
      return v;
    }
  };
  return {
    id: row.id,
    created_at: row.created_at,
    week: row.week,
    opponent: row.opponent,
    kind: row.kind,
    summary: row.summary,
    before: decode(row.before_json),
    after: decode(row.after_json),
    cleared_at: row.cleared_at,
  };
}

/** Uncleared alerts, newest first. */
export function getActiveAlerts(db: Database.Database, limit = 50): LionsAlertRow[] {
  const rows = db.prepare(
    'SELECT * FROM lions_alerts WHERE cleared_at IS NULL ORDER BY id DESC LIMIT ?',
  ).all(limit) as RawAlertRow[];
  return rows.map(hydrate);
}

/** Clear every active alert. Returns how many rows were cleared. */
export function clearAlerts(db: Database.Database, nowIso: string): number {
  return db.prepare('UPDATE lions_alerts SET cleared_at = ? WHERE cleared_at IS NULL').run(nowIso).changes;
}
