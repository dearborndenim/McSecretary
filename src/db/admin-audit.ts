import type Database from 'better-sqlite3';

/**
 * Writes made from the staff admin UI (staff admin UI spec §2): one row per
 * change, `actor` = 'staff-ui'. Read in the DB; the UI does not list it.
 */
export function initializeAdminAuditSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS admin_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      target TEXT,
      detail_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_admin_audit_at ON admin_audit (at);
  `);
}

export interface AdminAuditRow {
  id: number;
  at: string;
  actor: string;
  action: string;
  target: string | null;
  detail_json: string;
}

export function recordAdminAudit(
  db: Database.Database,
  entry: { action: string; target: string | null; detail?: Record<string, unknown>; actor?: string },
  nowIso: string,
): void {
  db.prepare('INSERT INTO admin_audit (at, actor, action, target, detail_json) VALUES (?, ?, ?, ?, ?)')
    .run(nowIso, entry.actor ?? 'staff-ui', entry.action, entry.target, JSON.stringify(entry.detail ?? {}));
}
