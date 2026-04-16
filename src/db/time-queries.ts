import type Database from 'better-sqlite3';

export interface TimeLogRow {
  id: number;
  date: string;
  hour: number;
  activity: string;
  category: string;
  project_id: string | null;
  logged_at: string;
  user_id: string;
}

export function insertTimeLog(
  db: Database.Database,
  userId: string,
  entry: { date: string; hour: number; activity: string; category?: string; project_id?: string },
): void {
  db.prepare(`
    INSERT OR REPLACE INTO time_log (date, hour, activity, category, project_id, user_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(entry.date, entry.hour, entry.activity, entry.category ?? 'untracked', entry.project_id ?? null, userId);
}

export function getTimeLogsForDate(db: Database.Database, userId: string, date: string): TimeLogRow[] {
  return db.prepare(`
    SELECT * FROM time_log WHERE user_id = ? AND date = ? ORDER BY hour ASC
  `).all(userId, date) as TimeLogRow[];
}

export function getTodayTrackedHours(db: Database.Database, userId: string, date: string): number {
  const row = db.prepare(`
    SELECT COUNT(*) as count FROM time_log WHERE user_id = ? AND date = ?
  `).get(userId, date) as { count: number };
  return row.count;
}
