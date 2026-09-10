import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import {
  addAlerts,
  clearAlerts,
  getActiveAlerts,
  getLatestSnapshot,
  initializeLionsSchema,
  saveSnapshot,
} from '../../src/lions/store.js';
import type { ScheduleChange } from '../../src/lions/diff.js';
import type { LionsGame } from '../../src/lions/parse.js';

const NOW = '2026-09-09T23:00:00.000Z';
const LATER = '2026-09-10T18:00:00.000Z';

const game: LionsGame = {
  week: 5, date: '2026-10-17', time: '1:00 PM', home: 'SOUTH LOOP', away: 'SKINNER',
  opponent: 'SKINNER', isHome: true, venue: 'Crane HS', notes: 'north pitch',
};

function change(over: Partial<ScheduleChange> = {}): ScheduleChange {
  return {
    week: 5, opponent: 'SKINNER', opponentLabel: 'Skinner', isHome: true,
    kind: 'time_changed', summary: 'Week 5 vs Skinner: 1:00 PM → 2:00 PM',
    before: '1:00 PM', after: '2:00 PM', ...over,
  };
}

describe('lions store', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); initializeSchema(db); });
  afterEach(() => db.close());

  it('is created by initializeSchema and is idempotent', () => {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name);
    expect(tables).toContain('lions_schedule_snapshots');
    expect(tables).toContain('lions_alerts');
    expect(() => initializeLionsSchema(db)).not.toThrow();
  });

  it('round-trips a snapshot including optional fields', () => {
    expect(getLatestSnapshot(db)).toBeNull();
    saveSnapshot(db, [game], 'hash-1', NOW);
    const snapshot = getLatestSnapshot(db)!;
    expect(snapshot).toMatchObject({ taken_at: NOW, source_hash: 'hash-1' });
    expect(snapshot.games).toEqual([game]);
  });

  it('returns the newest snapshot', () => {
    saveSnapshot(db, [game], 'hash-1', NOW);
    saveSnapshot(db, [{ ...game, time: '2:00 PM' }], 'hash-2', LATER);
    const snapshot = getLatestSnapshot(db)!;
    expect(snapshot.source_hash).toBe('hash-2');
    expect(snapshot.games[0]!.time).toBe('2:00 PM');
  });

  it('records alerts and returns them newest first', () => {
    addAlerts(db, [change()], NOW);
    addAlerts(db, [change({ week: 6, opponent: 'STEM', kind: 'game_removed', summary: 'Week 6 at STEM removed', after: null })], LATER);

    const active = getActiveAlerts(db);
    expect(active.map((a) => a.week)).toEqual([6, 5]);
    expect(active[0]).toMatchObject({ kind: 'game_removed', after: null, created_at: LATER, cleared_at: null });
    expect(active[1]).toMatchObject({ kind: 'time_changed', before: '1:00 PM', after: '2:00 PM' });
  });

  it('returns the ids it inserted, in order', () => {
    const ids = addAlerts(db, [change(), change({ kind: 'date_changed' })], NOW);
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe(ids[0]! + 1);
  });

  it('honours the limit', () => {
    addAlerts(db, [change({ week: 1 }), change({ week: 2 }), change({ week: 3 })], NOW);
    expect(getActiveAlerts(db, 2).map((a) => a.week)).toEqual([3, 2]);
  });

  it('clears active alerts and leaves cleared ones alone', () => {
    addAlerts(db, [change(), change({ week: 6 })], NOW);
    expect(clearAlerts(db, LATER)).toBe(2);
    expect(getActiveAlerts(db)).toEqual([]);
    expect(clearAlerts(db, LATER)).toBe(0);

    const cleared = db.prepare('SELECT cleared_at FROM lions_alerts').all() as { cleared_at: string }[];
    expect(cleared.every((r) => r.cleared_at === LATER)).toBe(true);

    // A later change pops a fresh alert.
    addAlerts(db, [change({ week: 7 })], LATER);
    expect(getActiveAlerts(db).map((a) => a.week)).toEqual([7]);
  });
});
