import type Database from 'better-sqlite3';

/**
 * Tables behind the staff admin UI (staff admin UI spec §2):
 * - `admin_audit`: one row per UI write (and per login), actor 'staff-ui'.
 * - `staff_sessions`: one row per signed-in browser, keyed by the session
 *   nonce the cookie carries; sign-out sets revoked_at, so a copied cookie
 *   stops working even though its signature is still valid.
 */
export function initializeStaffUiSchema(db: Database.Database): void {
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

    CREATE TABLE IF NOT EXISTS staff_sessions (
      nonce TEXT PRIMARY KEY,
      issued_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT
    );
  `);
}

export function recordAdminAudit(
  db: Database.Database,
  entry: { action: string; target: string | null; detail?: Record<string, unknown>; actor?: string },
  nowIso: string,
): void {
  db.prepare('INSERT INTO admin_audit (at, actor, action, target, detail_json) VALUES (?, ?, ?, ?, ?)')
    .run(nowIso, entry.actor ?? 'staff-ui', entry.action, entry.target, JSON.stringify(entry.detail ?? {}));
}

export function insertStaffSession(db: Database.Database, nonce: string, issuedIso: string, expiresIso: string): void {
  db.prepare('INSERT INTO staff_sessions (nonce, issued_at, expires_at) VALUES (?, ?, ?)').run(nonce, issuedIso, expiresIso);
}

/** True when the nonce has a session row that is neither revoked nor expired. */
export function staffSessionLive(db: Database.Database, nonce: string, nowIso: string): boolean {
  return db.prepare('SELECT 1 FROM staff_sessions WHERE nonce = ? AND revoked_at IS NULL AND expires_at > ?')
    .get(nonce, nowIso) !== undefined;
}

export function revokeStaffSession(db: Database.Database, nonce: string, nowIso: string): void {
  db.prepare('UPDATE staff_sessions SET revoked_at = ? WHERE nonce = ? AND revoked_at IS NULL').run(nowIso, nonce);
}

/** Drop sessions past their expiry (revoked or not). Returns how many. */
export function sweepStaffSessions(db: Database.Database, nowIso: string): number {
  return db.prepare('DELETE FROM staff_sessions WHERE expires_at <= ?').run(nowIso).changes;
}
