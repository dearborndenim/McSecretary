import type Database from 'better-sqlite3';

export interface DevRequest {
  id: number;
  user_id: string;
  project: string | null;
  description: string;
  status: string;
  refined_description: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  rejection_reason: string | null;
  created_at: string;
  synced_at: string | null;
}

export function insertDevRequest(
  db: Database.Database,
  input: { user_id: string; project?: string; description: string },
): number {
  const result = db.prepare(`
    INSERT INTO dev_requests (user_id, project, description)
    VALUES (?, ?, ?)
  `).run(input.user_id, input.project ?? null, input.description);
  return Number(result.lastInsertRowid);
}

export function getDevRequestById(db: Database.Database, id: number): DevRequest | undefined {
  return db.prepare('SELECT * FROM dev_requests WHERE id = ?').get(id) as DevRequest | undefined;
}

export function getPendingDevRequests(db: Database.Database): DevRequest[] {
  return db.prepare(
    "SELECT * FROM dev_requests WHERE status = 'pending' ORDER BY created_at ASC"
  ).all() as DevRequest[];
}

export function getDevRequestsByUser(db: Database.Database, userId: string): DevRequest[] {
  return db.prepare(
    'SELECT * FROM dev_requests WHERE user_id = ? ORDER BY created_at DESC'
  ).all(userId) as DevRequest[];
}

export function approveDevRequest(
  db: Database.Database,
  id: number,
  reviewedBy: string,
  refinedDescription?: string,
): void {
  db.prepare(`
    UPDATE dev_requests
    SET status = 'approved',
        reviewed_by = ?,
        reviewed_at = datetime('now'),
        refined_description = ?
    WHERE id = ?
  `).run(reviewedBy, refinedDescription ?? null, id);
}

export function rejectDevRequest(
  db: Database.Database,
  id: number,
  reviewedBy: string,
  reason: string,
): void {
  db.prepare(`
    UPDATE dev_requests
    SET status = 'rejected',
        reviewed_by = ?,
        reviewed_at = datetime('now'),
        rejection_reason = ?
    WHERE id = ?
  `).run(reviewedBy, reason, id);
}

export function getApprovedDevRequests(db: Database.Database): DevRequest[] {
  return db.prepare(
    "SELECT * FROM dev_requests WHERE status = 'approved' ORDER BY reviewed_at ASC"
  ).all() as DevRequest[];
}

/**
 * Approved requests that have not yet been written back to NIGHTLY_PLAN.md on GitHub.
 * Used by the update_nightly_plan empire tool.
 */
export function getApprovedUnsyncedDevRequests(db: Database.Database): DevRequest[] {
  return db.prepare(
    "SELECT * FROM dev_requests WHERE status = 'approved' AND synced_at IS NULL ORDER BY reviewed_at ASC"
  ).all() as DevRequest[];
}

export function markDevRequestSynced(db: Database.Database, id: number): void {
  db.prepare("UPDATE dev_requests SET synced_at = datetime('now') WHERE id = ?").run(id);
}
