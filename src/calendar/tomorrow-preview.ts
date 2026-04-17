/**
 * Build a short "Coming up tomorrow" string from Outlook calendar events.
 * Used in end-of-day summaries to preview tomorrow's schedule for each user.
 */

import type Database from 'better-sqlite3';
import { getUserEmailAccounts } from '../db/user-queries.js';
import { fetchOutlookCalendarEvents } from './outlook-calendar.js';
import { TIMEZONE } from './types.js';

function getTomorrowDateBoundsUtc(now: Date = new Date()): { startUtc: string; endUtc: string } {
  // Convert `now` to Chicago date → add 1 day → use 00:00 CT to 23:59:59 CT → express in UTC.
  const chicagoToday = now.toLocaleDateString('en-CA', { timeZone: TIMEZONE });
  const [y, m, d] = chicagoToday.split('-').map((s) => parseInt(s, 10)) as [number, number, number];
  // Tomorrow's date in Chicago
  const tomorrow = new Date(Date.UTC(y, m - 1, d + 1, 0, 0, 0));
  // Chicago is UTC-6 (CDT) or UTC-5 — we'll approximate using Intl to offset:
  // simpler: call fetchOutlookCalendarEvents with ISO boundaries in UTC spanning 24h,
  // plus enough slack to cover DST edges. We'll use ±6 hours.
  const startUtc = new Date(tomorrow.getTime() - 6 * 60 * 60 * 1000).toISOString();
  const endUtc = new Date(tomorrow.getTime() + 30 * 60 * 60 * 1000).toISOString();
  return { startUtc, endUtc };
}

export async function getTomorrowEventsPreview(
  db: Database.Database,
  userId: string,
  now: Date = new Date(),
): Promise<string> {
  const accounts = getUserEmailAccounts(db, userId);
  if (accounts.length === 0) return 'No events scheduled for tomorrow.';

  const { startUtc, endUtc } = getTomorrowDateBoundsUtc(now);

  let events: { title: string; startTime: string; location: string }[] = [];
  try {
    const results = await Promise.all(
      accounts.map((a) =>
        fetchOutlookCalendarEvents(a.email_address, startUtc, endUtc).catch(() => []),
      ),
    );
    events = results.flat();
  } catch {
    return 'No events scheduled for tomorrow.';
  }

  // Filter down to actual Chicago "tomorrow" date so the ±6h window doesn't leak in.
  const tomorrowDate = new Date(now.getTime() + 24 * 60 * 60 * 1000)
    .toLocaleDateString('en-CA', { timeZone: TIMEZONE });
  const onTomorrow = events.filter((e) => {
    const d = new Date(e.startTime).toLocaleDateString('en-CA', { timeZone: TIMEZONE });
    return d === tomorrowDate;
  });

  if (onTomorrow.length === 0) return 'No events scheduled for tomorrow.';

  const sorted = onTomorrow.sort(
    (a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime(),
  );

  const lines = sorted.map((e) => {
    const t = new Date(e.startTime).toLocaleTimeString('en-US', {
      timeZone: TIMEZONE,
      hour: 'numeric',
      minute: '2-digit',
    });
    const loc = e.location ? ` @ ${e.location}` : '';
    return `- ${t} — ${e.title}${loc}`;
  });

  return `Coming up tomorrow:\n${lines.join('\n')}`;
}
