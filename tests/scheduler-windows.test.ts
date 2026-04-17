import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../src/db/schema.js';
import { createUser, setUserScheduleWindows } from '../src/db/user-queries.js';
import { isWithinCronWindow, shouldUserCheckInNow, shouldUserEodNow } from '../src/scheduler-windows.js';

describe('cron window matching', () => {
  describe('isWithinCronWindow', () => {
    it('matches the exact minute and hour for "0 6-19 * * 1-5"', () => {
      // Wednesday 2026-04-15 at 7:00 AM
      const date = new Date('2026-04-15T07:00:00-05:00'); // CT
      expect(isWithinCronWindow('0 6-19 * * 1-5', date, 'America/Chicago')).toBe(true);
    });

    it('rejects minute 30 for "0 6-19 * * 1-5"', () => {
      const date = new Date('2026-04-15T07:30:00-05:00');
      expect(isWithinCronWindow('0 6-19 * * 1-5', date, 'America/Chicago')).toBe(false);
    });

    it('rejects hour outside range', () => {
      const date = new Date('2026-04-15T20:00:00-05:00');
      expect(isWithinCronWindow('0 6-19 * * 1-5', date, 'America/Chicago')).toBe(false);
    });

    it('rejects Saturday for weekday-only schedule', () => {
      // 2026-04-18 is a Saturday
      const date = new Date('2026-04-18T10:00:00-05:00');
      expect(isWithinCronWindow('0 6-19 * * 1-5', date, 'America/Chicago')).toBe(false);
    });

    it('matches "30 14 * * 1-5" only at 2:30 PM weekdays', () => {
      const date = new Date('2026-04-15T14:30:00-05:00');
      expect(isWithinCronWindow('30 14 * * 1-5', date, 'America/Chicago')).toBe(true);
      const other = new Date('2026-04-15T14:00:00-05:00');
      expect(isWithinCronWindow('30 14 * * 1-5', other, 'America/Chicago')).toBe(false);
    });

    it('matches wildcard "*"', () => {
      const date = new Date('2026-04-15T10:30:00-05:00');
      expect(isWithinCronWindow('* * * * *', date, 'America/Chicago')).toBe(true);
    });
  });

  describe('per-user gating', () => {
    let db: Database.Database;

    beforeEach(() => {
      db = new Database(':memory:');
      initializeSchema(db);
      createUser(db, { id: 'admin1', name: 'Robert', email: 'rob@dd.com', role: 'admin' });
      createUser(db, { id: 'olivier', name: 'Olivier', email: 'o@dd.com', role: 'member' });
      // Robert: 6 AM – 7 PM weekdays
      setUserScheduleWindows(db, 'admin1', {
        check_in_cron: '0 6-19 * * 1-5',
        eod_cron: '0 19 * * 1-5',
      });
      // Olivier: 6 AM – 2:30 PM weekdays
      setUserScheduleWindows(db, 'olivier', {
        check_in_cron: '0 6-14 * * 1-5',
        eod_cron: '30 14 * * 1-5',
      });
    });

    it('admin check-in fires at 3 PM weekdays', () => {
      const date = new Date('2026-04-15T15:00:00-05:00');
      expect(shouldUserCheckInNow(db, 'admin1', date)).toBe(true);
    });

    it('member check-in skipped at 3 PM (outside their 6-2 window)', () => {
      const date = new Date('2026-04-15T15:00:00-05:00');
      expect(shouldUserCheckInNow(db, 'olivier', date)).toBe(false);
    });

    it('admin EOD at 7 PM fires for admin, skipped for member', () => {
      const date = new Date('2026-04-15T19:00:00-05:00');
      expect(shouldUserEodNow(db, 'admin1', date)).toBe(true);
      expect(shouldUserEodNow(db, 'olivier', date)).toBe(false);
    });

    it('member EOD at 2:30 PM fires for member, skipped for admin', () => {
      const date = new Date('2026-04-15T14:30:00-05:00');
      expect(shouldUserEodNow(db, 'olivier', date)).toBe(true);
      expect(shouldUserEodNow(db, 'admin1', date)).toBe(false);
    });
  });
});
