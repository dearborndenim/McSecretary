import type Database from 'better-sqlite3';

export interface ScheduledTaskRow {
  name: string;
  cron_expression: string;
  enabled: number;
  description: string;
  updated_at: string;
}

export function upsertScheduledTask(
  db: Database.Database,
  name: string,
  cronExpression: string,
  description: string = '',
  enabled: boolean = true,
): void {
  db.prepare(`
    INSERT OR REPLACE INTO scheduled_tasks (name, cron_expression, enabled, description, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `).run(name, cronExpression, enabled ? 1 : 0, description);
}

export function getScheduledTasks(db: Database.Database): ScheduledTaskRow[] {
  return db.prepare(`
    SELECT * FROM scheduled_tasks ORDER BY name
  `).all() as ScheduledTaskRow[];
}

export function getEnabledScheduledTasks(db: Database.Database): ScheduledTaskRow[] {
  return db.prepare(`
    SELECT * FROM scheduled_tasks WHERE enabled = 1 ORDER BY name
  `).all() as ScheduledTaskRow[];
}

export function disableScheduledTask(db: Database.Database, name: string): void {
  db.prepare(`
    UPDATE scheduled_tasks SET enabled = 0, updated_at = datetime('now') WHERE name = ?
  `).run(name);
}

export function enableScheduledTask(db: Database.Database, name: string): void {
  db.prepare(`
    UPDATE scheduled_tasks SET enabled = 1, updated_at = datetime('now') WHERE name = ?
  `).run(name);
}

export function deleteScheduledTask(db: Database.Database, name: string): void {
  db.prepare(`DELETE FROM scheduled_tasks WHERE name = ?`).run(name);
}
