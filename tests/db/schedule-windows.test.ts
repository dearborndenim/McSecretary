import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import {
  createUser,
  getUserById,
  setUserScheduleWindows,
  getUserScheduleWindows,
} from '../../src/db/user-queries.js';

describe('per-user schedule windows', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
  });

  it('adds check_in_cron and eod_cron columns to users table', () => {
    const info = db.prepare('PRAGMA table_info(users)').all() as { name: string }[];
    const colNames = info.map((c) => c.name);
    expect(colNames).toContain('check_in_cron');
    expect(colNames).toContain('eod_cron');
  });

  it('defaults admin to Robert-style schedule on first insert', () => {
    createUser(db, { id: 'admin1', name: 'Robert', email: 'rob@dd.com', role: 'admin' });
    const windows = getUserScheduleWindows(db, 'admin1');
    expect(windows).toBeDefined();
    // Fallback defaults come from getUserScheduleWindows itself
    expect(windows!.check_in_cron).toBeTruthy();
    expect(windows!.eod_cron).toBeTruthy();
  });

  it('allows custom per-user schedule windows to be set and read back', () => {
    createUser(db, { id: 'olivier', name: 'Olivier', email: 'o@dd.com', role: 'member' });
    setUserScheduleWindows(db, 'olivier', {
      check_in_cron: '0 6-14 * * 1-5',
      eod_cron: '30 14 * * 1-5',
    });
    const windows = getUserScheduleWindows(db, 'olivier');
    expect(windows!.check_in_cron).toBe('0 6-14 * * 1-5');
    expect(windows!.eod_cron).toBe('30 14 * * 1-5');
  });

  it('returns undefined for non-existent user', () => {
    const windows = getUserScheduleWindows(db, 'no-such-user');
    expect(windows).toBeUndefined();
  });
});
