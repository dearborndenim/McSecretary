/**
 * Timezone-awareness tests for the per-user schedule window gates.
 *
 * Prior to Task 6.3, `shouldUserCheckInNow` / `shouldUserEodNow` hard-coded
 * the timezone to `America/Chicago`, which meant a user with
 * `users.timezone = 'America/New_York'` whose cron said "0 7 * * 1-5"
 * would fire at 7 AM CT (= 8 AM ET) instead of at 7 AM ET as intended.
 *
 * This file pins the new behavior: when a user has an explicit `timezone`
 * column, the cron matcher must evaluate the date in that timezone. If the
 * timezone is NULL or missing, CT remains the default.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../src/db/schema.js';
import {
  createUser,
  setUserScheduleWindows,
} from '../src/db/user-queries.js';
import {
  shouldUserCheckInNow,
  shouldUserEodNow,
  isWithinCronWindow,
} from '../src/scheduler-windows.js';

describe('scheduler-windows honors user.timezone', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
  });

  it('fires at 7 AM CT for a CT user', () => {
    createUser(db, {
      id: 'ct-user', name: 'CT', email: 'ct@dd.com', role: 'member',
      timezone: 'America/Chicago',
    });
    setUserScheduleWindows(db, 'ct-user', {
      check_in_cron: '0 7 * * 1-5',
      eod_cron: '0 17 * * 1-5',
    });
    // 2026-04-15 Wed 7 AM CT = 12:00 UTC
    const date = new Date('2026-04-15T12:00:00Z');
    expect(shouldUserCheckInNow(db, 'ct-user', date)).toBe(true);
  });

  it('fires at 7 AM ET for an ET user (1 hour earlier than CT)', () => {
    createUser(db, {
      id: 'et-user', name: 'ET', email: 'et@dd.com', role: 'member',
      timezone: 'America/New_York',
    });
    setUserScheduleWindows(db, 'et-user', {
      check_in_cron: '0 7 * * 1-5',
      eod_cron: '0 17 * * 1-5',
    });
    // 2026-04-15 Wed 7 AM ET = 11:00 UTC
    const date = new Date('2026-04-15T11:00:00Z');
    expect(shouldUserCheckInNow(db, 'et-user', date)).toBe(true);
    // And does NOT fire at 7 AM CT (= 8 AM ET) for an ET user.
    expect(shouldUserCheckInNow(db, 'et-user', new Date('2026-04-15T12:00:00Z'))).toBe(false);
  });

  it('fires at 7 AM PT for a PT user (2 hours later than CT)', () => {
    createUser(db, {
      id: 'pt-user', name: 'PT', email: 'pt@dd.com', role: 'member',
      timezone: 'America/Los_Angeles',
    });
    setUserScheduleWindows(db, 'pt-user', {
      check_in_cron: '0 7 * * 1-5',
      eod_cron: '0 17 * * 1-5',
    });
    // 2026-04-15 Wed 7 AM PT = 14:00 UTC
    const date = new Date('2026-04-15T14:00:00Z');
    expect(shouldUserCheckInNow(db, 'pt-user', date)).toBe(true);
    // And does NOT fire at 7 AM CT (= 5 AM PT) for a PT user.
    expect(shouldUserCheckInNow(db, 'pt-user', new Date('2026-04-15T12:00:00Z'))).toBe(false);
  });

  it('fires at 12 PM UTC for a UTC user', () => {
    createUser(db, {
      id: 'utc-user', name: 'UTC', email: 'utc@dd.com', role: 'member',
      timezone: 'UTC',
    });
    setUserScheduleWindows(db, 'utc-user', {
      check_in_cron: '0 12 * * 1-5',
      eod_cron: '0 17 * * 1-5',
    });
    const date = new Date('2026-04-15T12:00:00Z');
    expect(shouldUserCheckInNow(db, 'utc-user', date)).toBe(true);
  });

  it('7 AM CT == 8 AM ET boundary: the same wall-clock UTC moment fires differently per timezone', () => {
    createUser(db, {
      id: 'ct-boundary', name: 'CT', email: 'ctb@dd.com', role: 'member',
      timezone: 'America/Chicago',
    });
    createUser(db, {
      id: 'et-boundary', name: 'ET', email: 'etb@dd.com', role: 'member',
      timezone: 'America/New_York',
    });
    // Both users want to be poked at 7 AM local.
    setUserScheduleWindows(db, 'ct-boundary', {
      check_in_cron: '0 7 * * 1-5',
      eod_cron: '0 17 * * 1-5',
    });
    setUserScheduleWindows(db, 'et-boundary', {
      check_in_cron: '0 7 * * 1-5',
      eod_cron: '0 17 * * 1-5',
    });
    // At 12:00 UTC on 2026-04-15:
    //   - CT (UTC-5 CDT): 7 AM CT     -> CT user fires
    //   - ET (UTC-4 EDT): 8 AM ET     -> ET user does not fire
    const date = new Date('2026-04-15T12:00:00Z');
    expect(shouldUserCheckInNow(db, 'ct-boundary', date)).toBe(true);
    expect(shouldUserCheckInNow(db, 'et-boundary', date)).toBe(false);
  });

  it('EOD gate honors user.timezone just like check-in', () => {
    createUser(db, {
      id: 'pt-user', name: 'PT', email: 'pt@dd.com', role: 'member',
      timezone: 'America/Los_Angeles',
    });
    setUserScheduleWindows(db, 'pt-user', {
      check_in_cron: '0 7 * * 1-5',
      eod_cron: '30 14 * * 1-5',
    });
    // 2026-04-15 Wed 2:30 PM PT = 21:30 UTC
    const date = new Date('2026-04-15T21:30:00Z');
    expect(shouldUserEodNow(db, 'pt-user', date)).toBe(true);
    // 2:30 PM CT is NOT 2:30 PM PT — does not fire for PT user.
    expect(shouldUserEodNow(db, 'pt-user', new Date('2026-04-15T19:30:00Z'))).toBe(false);
  });

  it('falls back to America/Chicago when user.timezone is null/empty', () => {
    // Createuser sets timezone default to America/Chicago. Simulate a
    // legacy row by updating to empty string.
    createUser(db, { id: 'legacy', name: 'Legacy', email: 'l@dd.com', role: 'member' });
    db.prepare('UPDATE users SET timezone = ? WHERE id = ?').run('', 'legacy');
    setUserScheduleWindows(db, 'legacy', {
      check_in_cron: '0 7 * * 1-5',
      eod_cron: '0 17 * * 1-5',
    });
    // 7 AM CT = 12:00 UTC — must still fire when timezone is empty.
    const date = new Date('2026-04-15T12:00:00Z');
    expect(shouldUserCheckInNow(db, 'legacy', date)).toBe(true);
  });

  it('isWithinCronWindow accepts an arbitrary IANA timezone (pure function)', () => {
    // Friday 2026-04-17 at 10:00 AM Tokyo = 01:00 UTC Friday
    expect(
      isWithinCronWindow('0 10 * * 1-5', new Date('2026-04-17T01:00:00Z'), 'Asia/Tokyo'),
    ).toBe(true);
    // Same UTC moment in CT is Thu 8 PM — wrong hour and wrong weekday in CT
    // for the weekday match, so CT users would NOT fire at this moment.
    expect(
      isWithinCronWindow('0 10 * * 1-5', new Date('2026-04-17T01:00:00Z'), 'America/Chicago'),
    ).toBe(false);
  });
});

describe('CT remains the baseline assumption', () => {
  it('new users get America/Chicago as their default timezone', () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    createUser(db, { id: 'u1', name: 'x', email: 'x@dd.com', role: 'admin' });
    const row = db.prepare('SELECT timezone FROM users WHERE id = ?').get('u1') as { timezone: string };
    expect(row.timezone).toBe('America/Chicago');
  });
});
