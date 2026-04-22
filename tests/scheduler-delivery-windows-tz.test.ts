/**
 * Full scheduling-flow timezone tests for ET and PT staff.
 *
 * The existing `tests/scheduler-windows-timezone.test.ts` spot-covers the
 * pure timezone lookup (one-point-in-time evaluations). This file goes one
 * layer deeper: simulate the actual scheduler loop that fires every 30
 * minutes for a full weekday and assert which UTC moments cause each user
 * to receive a check-in / EOD in their LOCAL time.
 *
 * This guards against regressions where the per-user gate stops honoring
 * `users.timezone` end-to-end even if the pure `isWithinCronWindow` still
 * works.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../src/db/schema.js';
import {
  createUser,
  setUserScheduleWindows,
} from '../src/db/user-queries.js';
import { shouldUserCheckInNow, shouldUserEodNow } from '../src/scheduler-windows.js';

/**
 * Enumerate every 30-minute tick on a given UTC day that the scheduler's
 * hourly handler would fire at. Returns the Date objects the shared handler
 * would see.
 */
function everyHalfHour(dayIso: string): Date[] {
  const base = new Date(`${dayIso}T00:00:00Z`).getTime();
  const ticks: Date[] = [];
  for (let i = 0; i < 48; i++) {
    ticks.push(new Date(base + i * 30 * 60 * 1000));
  }
  return ticks;
}

/**
 * Simulate the per-user check-in gate across every 30-min tick on the given
 * UTC day and return the set of UTC ISO strings where the gate was open.
 */
function checkInTicksForUser(db: Database.Database, userId: string, dayIso: string): string[] {
  return everyHalfHour(dayIso)
    .filter((tick) => shouldUserCheckInNow(db, userId, tick))
    .map((d) => d.toISOString());
}

function eodTicksForUser(db: Database.Database, userId: string, dayIso: string): string[] {
  return everyHalfHour(dayIso)
    .filter((tick) => shouldUserEodNow(db, userId, tick))
    .map((d) => d.toISOString());
}

describe('Full scheduling flow — ET staff receive check-ins at ET local time', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
    createUser(db, {
      id: 'et-staff',
      name: 'Jordan ET',
      email: 'jordan@dd.com',
      role: 'member',
      timezone: 'America/New_York',
    });
    // Staff window: check-ins at 7 AM & 8 AM local, EOD at 5 PM local.
    setUserScheduleWindows(db, 'et-staff', {
      check_in_cron: '0 7,8 * * 1-5',
      eod_cron: '0 17 * * 1-5',
    });
  });

  it('fires 7 AM + 8 AM ET check-ins on a weekday (= 11:00 + 12:00 UTC during EDT)', () => {
    // 2026-04-15 is a Wednesday in EDT (UTC-4).
    const ticks = checkInTicksForUser(db, 'et-staff', '2026-04-15');
    expect(ticks).toEqual([
      '2026-04-15T11:00:00.000Z', // 7 AM ET
      '2026-04-15T12:00:00.000Z', // 8 AM ET
    ]);
  });

  it('does NOT fire at 7 AM CT (= 8 AM ET) — that would be one hour too late for the ET user', () => {
    // 7 AM CT on 2026-04-15 is 12:00 UTC. Under the ET cron 0 7,8, this is
    // 8 AM ET — which happens to match the 8 AM spot. The important test is
    // that 7 AM CT (= 8 AM ET) is NOT the same as 7 AM ET.
    // Construct a cron that only fires at 7 AM local for ET:
    setUserScheduleWindows(db, 'et-staff', {
      check_in_cron: '0 7 * * 1-5',
      eod_cron: '0 17 * * 1-5',
    });
    expect(shouldUserCheckInNow(db, 'et-staff', new Date('2026-04-15T11:00:00Z'))).toBe(true); // 7 AM ET
    expect(shouldUserCheckInNow(db, 'et-staff', new Date('2026-04-15T12:00:00Z'))).toBe(false); // 7 AM CT = 8 AM ET
  });

  it('does not fire on weekends (Sat/Sun) regardless of local time', () => {
    // 2026-04-18 is a Saturday, 2026-04-19 is a Sunday.
    const sat = checkInTicksForUser(db, 'et-staff', '2026-04-18');
    const sun = checkInTicksForUser(db, 'et-staff', '2026-04-19');
    expect(sat).toEqual([]);
    expect(sun).toEqual([]);
  });

  it('EOD fires at 5 PM ET (= 21:00 UTC during EDT) and nowhere else', () => {
    const ticks = eodTicksForUser(db, 'et-staff', '2026-04-15');
    expect(ticks).toEqual(['2026-04-15T21:00:00.000Z']);
  });
});

describe('Full scheduling flow — PT staff receive check-ins at PT local time', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
    createUser(db, {
      id: 'pt-staff',
      name: 'Kai PT',
      email: 'kai@dd.com',
      role: 'member',
      timezone: 'America/Los_Angeles',
    });
    // Staff window: check-ins every hour 7 AM – 10 AM local, EOD 2:30 PM local.
    setUserScheduleWindows(db, 'pt-staff', {
      check_in_cron: '0 7-10 * * 1-5',
      eod_cron: '30 14 * * 1-5',
    });
  });

  it('fires at 7, 8, 9, 10 AM PT (= 14, 15, 16, 17 UTC during PDT)', () => {
    const ticks = checkInTicksForUser(db, 'pt-staff', '2026-04-15');
    expect(ticks).toEqual([
      '2026-04-15T14:00:00.000Z', // 7 AM PT
      '2026-04-15T15:00:00.000Z', // 8 AM PT
      '2026-04-15T16:00:00.000Z', // 9 AM PT
      '2026-04-15T17:00:00.000Z', // 10 AM PT
    ]);
  });

  it('does NOT fire at 7-10 AM CT (= 5-8 AM PT) — that would be hours too early', () => {
    // 7 AM CT on 2026-04-15 is 12:00 UTC. In PT that's 5 AM — not in the window.
    expect(shouldUserCheckInNow(db, 'pt-staff', new Date('2026-04-15T12:00:00Z'))).toBe(false);
    expect(shouldUserCheckInNow(db, 'pt-staff', new Date('2026-04-15T13:00:00Z'))).toBe(false); // 8 AM CT = 6 AM PT
  });

  it('EOD fires at 2:30 PM PT (= 21:30 UTC during PDT) and not at 2:30 PM CT', () => {
    const ticks = eodTicksForUser(db, 'pt-staff', '2026-04-15');
    expect(ticks).toEqual(['2026-04-15T21:30:00.000Z']);
    // 2:30 PM CT = 19:30 UTC; in PT that's 12:30 PM — not the configured EOD.
    expect(shouldUserEodNow(db, 'pt-staff', new Date('2026-04-15T19:30:00Z'))).toBe(false);
  });
});

describe('Mixed fleet — ET + PT staff co-exist on the same scheduler loop', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
    createUser(db, {
      id: 'et-u', name: 'ET', email: 'et@dd.com', role: 'member', timezone: 'America/New_York',
    });
    createUser(db, {
      id: 'pt-u', name: 'PT', email: 'pt@dd.com', role: 'member', timezone: 'America/Los_Angeles',
    });
    // Same cron string for both — "fire at 9 AM local Mon-Fri".
    setUserScheduleWindows(db, 'et-u', { check_in_cron: '0 9 * * 1-5', eod_cron: '0 17 * * 1-5' });
    setUserScheduleWindows(db, 'pt-u', { check_in_cron: '0 9 * * 1-5', eod_cron: '0 17 * * 1-5' });
  });

  it('the 30-min scheduler tick fires each user exactly once at their local 9 AM', () => {
    const etTicks = checkInTicksForUser(db, 'et-u', '2026-04-15');
    const ptTicks = checkInTicksForUser(db, 'pt-u', '2026-04-15');
    expect(etTicks).toEqual(['2026-04-15T13:00:00.000Z']); // 9 AM ET = 13:00 UTC
    expect(ptTicks).toEqual(['2026-04-15T16:00:00.000Z']); // 9 AM PT = 16:00 UTC
  });

  it('at 9 AM ET (13:00 UTC), ONLY the ET user gate is open; PT user is still asleep (6 AM PT)', () => {
    const moment = new Date('2026-04-15T13:00:00Z');
    expect(shouldUserCheckInNow(db, 'et-u', moment)).toBe(true);
    expect(shouldUserCheckInNow(db, 'pt-u', moment)).toBe(false);
  });

  it('at 9 AM PT (16:00 UTC), ONLY the PT user gate is open; ET user is at noon', () => {
    const moment = new Date('2026-04-15T16:00:00Z');
    expect(shouldUserCheckInNow(db, 'et-u', moment)).toBe(false);
    expect(shouldUserCheckInNow(db, 'pt-u', moment)).toBe(true);
  });
});
