import type Database from 'better-sqlite3';

export interface CalendarEventRow {
  id: string;
  source: string;
  calendar_email: string;
  title: string;
  start_time: string;
  end_time: string;
  location: string;
  is_all_day: number;
  status: string;
  attendees: string;
  fetched_at: string;
}

export interface WeeklyScheduleRow {
  id: number;
  week_start: string;
  day_of_week: number;
  work_start: string;
  work_end: string;
  morning_routine: string;
  notes: string;
}

export interface PendingActionRow {
  id: number;
  created_at: string;
  action_type: string;
  source_event_id: string;
  source: string;
  calendar_email: string;
  description: string;
  proposed_data: string;
  status: string;
  expires_at: string;
}

export function upsertCalendarEvent(
  db: Database.Database,
  event: Omit<CalendarEventRow, 'fetched_at'>,
): void {
  db.prepare(`
    INSERT OR REPLACE INTO calendar_events
    (id, source, calendar_email, title, start_time, end_time, location, is_all_day, status, attendees)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.id, event.source, event.calendar_email, event.title,
    event.start_time, event.end_time, event.location,
    event.is_all_day, event.status, event.attendees
  );
}

export function getEventsForDateRange(
  db: Database.Database,
  startUtc: string,
  endUtc: string,
): CalendarEventRow[] {
  return db.prepare(`
    SELECT * FROM calendar_events
    WHERE start_time >= ? AND start_time < ?
    AND status != 'cancelled'
    ORDER BY start_time ASC
  `).all(startUtc, endUtc) as CalendarEventRow[];
}

export function upsertWeeklyScheduleDay(
  db: Database.Database,
  day: Omit<WeeklyScheduleRow, 'id'>,
): void {
  db.prepare(`
    INSERT OR REPLACE INTO weekly_schedule
    (week_start, day_of_week, work_start, work_end, morning_routine, notes)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(day.week_start, day.day_of_week, day.work_start, day.work_end, day.morning_routine, day.notes);
}

export function getWeeklySchedule(
  db: Database.Database,
  weekStart: string,
): WeeklyScheduleRow[] {
  return db.prepare(`
    SELECT * FROM weekly_schedule
    WHERE week_start = ?
    ORDER BY day_of_week ASC
  `).all(weekStart) as WeeklyScheduleRow[];
}

export function insertPendingAction(
  db: Database.Database,
  action: Omit<PendingActionRow, 'id' | 'created_at'>,
): number {
  const result = db.prepare(`
    INSERT INTO pending_actions
    (action_type, source_event_id, source, calendar_email, description, proposed_data, status, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    action.action_type, action.source_event_id, action.source,
    action.calendar_email, action.description, action.proposed_data,
    action.status, action.expires_at
  );
  return Number(result.lastInsertRowid);
}

export function getPendingActions(db: Database.Database): PendingActionRow[] {
  return db.prepare(`
    SELECT * FROM pending_actions
    WHERE status = 'pending'
    ORDER BY created_at ASC
  `).all() as PendingActionRow[];
}

export function expirePendingActions(db: Database.Database, now: string): void {
  db.prepare(`
    UPDATE pending_actions
    SET status = 'expired'
    WHERE status = 'pending' AND expires_at < ?
  `).run(now);
}
