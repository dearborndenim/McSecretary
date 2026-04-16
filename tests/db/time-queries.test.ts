import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import { insertTimeLog, getTimeLogsForDate, getTodayTrackedHours } from '../../src/db/time-queries.js';

describe('time queries', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
    // Seed a user for FK constraint
    db.prepare("INSERT INTO users (id, name, email, role) VALUES ('robert', 'Robert', 'rob@dd.com', 'admin')").run();
  });

  afterEach(() => {
    db.close();
  });

  it('inserts and retrieves a time log entry', () => {
    insertTimeLog(db, 'robert', { date: '2026-04-04', hour: 9, activity: 'Cut patterns for Brand Z' });
    const logs = getTimeLogsForDate(db, 'robert', '2026-04-04');
    expect(logs).toHaveLength(1);
    expect(logs[0]!.activity).toBe('Cut patterns for Brand Z');
    expect(logs[0]!.hour).toBe(9);
  });

  it('replaces entry for same date and hour', () => {
    insertTimeLog(db, 'robert', { date: '2026-04-04', hour: 9, activity: 'First activity' });
    insertTimeLog(db, 'robert', { date: '2026-04-04', hour: 9, activity: 'Updated activity' });
    const logs = getTimeLogsForDate(db, 'robert', '2026-04-04');
    expect(logs).toHaveLength(1);
    expect(logs[0]!.activity).toBe('Updated activity');
  });

  it('counts tracked hours for a date', () => {
    insertTimeLog(db, 'robert', { date: '2026-04-04', hour: 7, activity: 'Email' });
    insertTimeLog(db, 'robert', { date: '2026-04-04', hour: 8, activity: 'Patterns' });
    insertTimeLog(db, 'robert', { date: '2026-04-04', hour: 9, activity: 'Meeting' });
    expect(getTodayTrackedHours(db, 'robert', '2026-04-04')).toBe(3);
  });

  it('returns empty array for date with no entries', () => {
    const logs = getTimeLogsForDate(db, 'robert', '2026-04-04');
    expect(logs).toHaveLength(0);
  });
});
