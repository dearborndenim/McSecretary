import type Database from 'better-sqlite3';

export interface ProcessedEmail {
  id: string;
  account: string;
  sender: string;
  sender_name: string;
  subject: string;
  received_at: string;
  category: string;
  urgency: string;
  action_needed: string;
  action_taken: string;
  confidence: number;
  summary: string;
  thread_id: string;
  project_id?: string;
}

export interface SenderProfile {
  email: string;
  name: string | null;
  organization: string | null;
  default_category: string | null;
  default_urgency: string | null;
  total_emails: number;
  last_seen: string | null;
  is_vip: number;
  notes: string | null;
}

export function insertProcessedEmail(db: Database.Database, email: ProcessedEmail): void {
  db.prepare(`
    INSERT OR REPLACE INTO processed_emails
    (id, account, sender, sender_name, subject, received_at, category, urgency, action_needed, action_taken, confidence, summary, thread_id, project_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    email.id, email.account, email.sender, email.sender_name, email.subject,
    email.received_at, email.category, email.urgency, email.action_needed,
    email.action_taken, email.confidence, email.summary, email.thread_id,
    email.project_id ?? null
  );
}

export function getOrCreateSenderProfile(db: Database.Database, email: string, name: string | null): SenderProfile {
  const existing = db.prepare('SELECT * FROM sender_profiles WHERE email = ?').get(email) as SenderProfile | undefined;
  if (existing) return existing;

  db.prepare('INSERT INTO sender_profiles (email, name) VALUES (?, ?)').run(email, name);
  return db.prepare('SELECT * FROM sender_profiles WHERE email = ?').get(email) as SenderProfile;
}

export function updateSenderProfile(
  db: Database.Database,
  email: string,
  category: string,
  urgency: string,
): void {
  db.prepare(`
    UPDATE sender_profiles
    SET total_emails = total_emails + 1,
        last_seen = datetime('now'),
        default_category = ?,
        default_urgency = ?
    WHERE email = ?
  `).run(category, urgency, email);
}

export function insertAgentRun(db: Database.Database, runType: string): number {
  const result = db.prepare(`
    INSERT INTO agent_runs (started_at, run_type)
    VALUES (datetime('now'), ?)
  `).run(runType);
  return Number(result.lastInsertRowid);
}

export function completeAgentRun(
  db: Database.Database,
  runId: number,
  stats: { emails_processed: number; actions_taken: number; tokens_used: number; cost_estimate: number },
): void {
  db.prepare(`
    UPDATE agent_runs
    SET completed_at = datetime('now'),
        emails_processed = ?,
        actions_taken = ?,
        tokens_used = ?,
        cost_estimate = ?
    WHERE id = ?
  `).run(stats.emails_processed, stats.actions_taken, stats.tokens_used, stats.cost_estimate, runId);
}

export function insertAuditLog(
  db: Database.Database,
  entry: {
    action_type: string;
    target_id: string;
    target_type: string;
    details: string;
    confidence: number;
    approved_by?: string;
  },
): void {
  db.prepare(`
    INSERT INTO audit_log (action_type, target_id, target_type, details, confidence, approved_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(entry.action_type, entry.target_id, entry.target_type, entry.details, entry.confidence, entry.approved_by ?? null);
}

export function getLastRunTimestamp(db: Database.Database, runType: string): string | null {
  const row = db.prepare(`
    SELECT completed_at FROM agent_runs
    WHERE run_type = ? AND completed_at IS NOT NULL
    ORDER BY completed_at DESC
    LIMIT 1
  `).get(runType) as { completed_at: string } | undefined;
  return row?.completed_at ?? null;
}
