import type Database from 'better-sqlite3';

export function initializeCalendarSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS calendar_events (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      calendar_email TEXT NOT NULL,
      title TEXT,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      location TEXT DEFAULT '',
      is_all_day INTEGER DEFAULT 0,
      status TEXT DEFAULT 'confirmed',
      attendees TEXT DEFAULT '[]',
      fetched_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS weekly_schedule (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      week_start TEXT NOT NULL,
      day_of_week INTEGER NOT NULL,
      work_start TEXT DEFAULT '06:00',
      work_end TEXT DEFAULT '16:00',
      morning_routine TEXT DEFAULT 'default',
      notes TEXT DEFAULT '',
      UNIQUE(week_start, day_of_week)
    );

    CREATE TABLE IF NOT EXISTS pending_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT DEFAULT (datetime('now')),
      action_type TEXT NOT NULL,
      source_event_id TEXT NOT NULL,
      source TEXT NOT NULL,
      calendar_email TEXT NOT NULL,
      description TEXT NOT NULL,
      proposed_data TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      expires_at TEXT NOT NULL
    );
  `);
}
