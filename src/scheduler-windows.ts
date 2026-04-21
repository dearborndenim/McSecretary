/**
 * Per-user schedule-window gating.
 *
 * The hourly Check-In handler runs on a single cron (e.g. 0 6-19 * * 1-5).
 * We still want to send different users their own windows, so each user gets
 * a stored `check_in_cron` / `eod_cron` that the handler consults before sending.
 * This file has the pure cron-window matching logic + DB lookups.
 */

import type Database from 'better-sqlite3';
import { getUserScheduleWindows, getUserById } from './db/user-queries.js';

/** Default timezone used when a user row has a NULL/empty timezone column. */
const DEFAULT_TIMEZONE = 'America/Chicago';

/**
 * Minimal cron matcher that supports:
 *   - exact numbers:   0 7 * * 1
 *   - ranges:          6-19
 *   - lists:           1,3,5
 *   - wildcards:       *
 *   - step values:     \*\/5
 * Fields: minute hour day-of-month month day-of-week (Sun=0..Sat=6)
 */
export function isWithinCronWindow(
  cronExpression: string,
  date: Date,
  timezone: string,
): boolean {
  const parts = cronExpression.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [minuteField, hourField, domField, monthField, dowField] = parts as [
    string, string, string, string, string,
  ];

  // Convert the date to the target timezone's minute/hour/dom/month/dow.
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    minute: '2-digit',
    hour: '2-digit',
    hour12: false,
    day: 'numeric',
    month: 'numeric',
    weekday: 'short',
  });
  const partsArr = fmt.formatToParts(date);
  const lookup: Record<string, string> = {};
  for (const p of partsArr) lookup[p.type] = p.value;

  const minute = parseInt(lookup['minute'] ?? '0', 10);
  let hour = parseInt(lookup['hour'] ?? '0', 10);
  if (hour === 24) hour = 0; // en-US hour cycle sometimes reports 24
  const day = parseInt(lookup['day'] ?? '1', 10);
  const month = parseInt(lookup['month'] ?? '1', 10);
  const weekdayStr = lookup['weekday'] ?? 'Sun';
  const weekdayMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  const dow = weekdayMap[weekdayStr] ?? 0;

  return (
    matchField(minuteField, minute, 0, 59) &&
    matchField(hourField, hour, 0, 23) &&
    matchField(domField, day, 1, 31) &&
    matchField(monthField, month, 1, 12) &&
    matchField(dowField, dow, 0, 6)
  );
}

function matchField(field: string, value: number, min: number, max: number): boolean {
  if (field === '*') return true;
  // Handle lists:  1,3,5
  if (field.includes(',')) {
    return field.split(',').some((part) => matchField(part, value, min, max));
  }
  // Handle steps:  */5 or 0-30/5
  if (field.includes('/')) {
    const [base, stepStr] = field.split('/') as [string, string];
    const step = parseInt(stepStr, 10);
    const [rangeStart, rangeEnd] = parseRange(base, min, max);
    if (value < rangeStart || value > rangeEnd) return false;
    return (value - rangeStart) % step === 0;
  }
  // Range:  6-19
  if (field.includes('-')) {
    const [startStr, endStr] = field.split('-') as [string, string];
    const start = parseInt(startStr, 10);
    const end = parseInt(endStr, 10);
    return value >= start && value <= end;
  }
  // Exact number
  const num = parseInt(field, 10);
  return !Number.isNaN(num) && num === value;
}

function parseRange(base: string, min: number, max: number): [number, number] {
  if (base === '*') return [min, max];
  if (base.includes('-')) {
    const [s, e] = base.split('-') as [string, string];
    return [parseInt(s, 10), parseInt(e, 10)];
  }
  const n = parseInt(base, 10);
  return [n, max];
}

/**
 * Resolve the effective timezone for cron matching. Honors `users.timezone`
 * (IANA format, e.g. `America/New_York`) when set; falls back to
 * `America/Chicago` when the column is NULL or empty so legacy rows keep
 * working. Staff scheduled through the bulk-invite flow default to CT; this
 * lookup lets Robert override per-user via `UPDATE users SET timezone=...`.
 */
function getUserTimezone(db: Database.Database, userId: string): string {
  const user = getUserById(db, userId);
  if (!user) return DEFAULT_TIMEZONE;
  const tz = user.timezone?.trim();
  return tz && tz.length > 0 ? tz : DEFAULT_TIMEZONE;
}

export function shouldUserCheckInNow(
  db: Database.Database,
  userId: string,
  now: Date = new Date(),
): boolean {
  const windows = getUserScheduleWindows(db, userId);
  if (!windows) return false;
  const tz = getUserTimezone(db, userId);
  return isWithinCronWindow(windows.check_in_cron, now, tz);
}

export function shouldUserEodNow(
  db: Database.Database,
  userId: string,
  now: Date = new Date(),
): boolean {
  const windows = getUserScheduleWindows(db, userId);
  if (!windows) return false;
  const tz = getUserTimezone(db, userId);
  return isWithinCronWindow(windows.eod_cron, now, tz);
}
