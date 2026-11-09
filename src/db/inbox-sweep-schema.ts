import type Database from 'better-sqlite3';

/**
 * Inbox Sweep (plan docs/superpowers/plans/2026-11-06-inbox-sweep.md in the
 * claude_code repo):
 * - `inbox_sweep_state`: one watermark per mailbox, the newest receivedDateTime
 *   the sweep has handled. A mailbox with no row starts 15 minutes back.
 * - `inbox_sweep_log`: one row per message the sweep has decided on, unique on
 *   the Graph message id, so a re-fetched message is never acted on twice.
 */
export function initializeInboxSweepSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS inbox_sweep_state (
      mailbox TEXT PRIMARY KEY,
      last_received_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS inbox_sweep_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL UNIQUE,
      mailbox TEXT NOT NULL,
      received_at TEXT NOT NULL,
      sender TEXT,
      subject TEXT,
      lane TEXT NOT NULL,
      folder TEXT,
      bot TEXT,
      unsubscribed INTEGER NOT NULL DEFAULT 0,
      mode TEXT NOT NULL,
      note TEXT,
      at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_inbox_sweep_log_mailbox_at ON inbox_sweep_log(mailbox, at);
  `);
}

export function getSweepWatermark(db: Database.Database, mailbox: string): string | null {
  const row = db.prepare('SELECT last_received_at FROM inbox_sweep_state WHERE mailbox = ?').get(mailbox) as
    | { last_received_at: string }
    | undefined;
  return row?.last_received_at ?? null;
}

export function setSweepWatermark(db: Database.Database, mailbox: string, receivedAt: string): void {
  db.prepare(`
    INSERT INTO inbox_sweep_state (mailbox, last_received_at) VALUES (?, ?)
    ON CONFLICT(mailbox) DO UPDATE SET last_received_at = excluded.last_received_at
  `).run(mailbox, receivedAt);
}

export function isSweepLogged(db: Database.Database, messageId: string): boolean {
  return db.prepare('SELECT 1 FROM inbox_sweep_log WHERE message_id = ?').get(messageId) !== undefined;
}

export interface SweepLogInput {
  message_id: string;
  mailbox: string;
  received_at: string;
  sender: string;
  subject: string;
  lane: string;
  folder: string | null;
  bot: string | null;
  unsubscribed: boolean;
  mode: 'shadow' | 'live';
  note: string | null;
  at: string;
}

export function insertSweepLog(db: Database.Database, r: SweepLogInput): void {
  db.prepare(`
    INSERT OR IGNORE INTO inbox_sweep_log
      (message_id, mailbox, received_at, sender, subject, lane, folder, bot, unsubscribed, mode, note, at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    r.message_id, r.mailbox, r.received_at, r.sender, r.subject, r.lane, r.folder, r.bot,
    r.unsubscribed ? 1 : 0, r.mode, r.note, r.at,
  );
}

/** Triage categories that mark a sender as a real correspondent (never unsubscribed). */
const CORRESPONDENT_CATEGORIES = ['customer_inquiry', 'supplier', 'team_internal', 'financial', 'personal'];

/**
 * True when local records show the sender is a vendor, customer, staff member or
 * other real correspondent: a domain we sent an RFQ to, or an address the triage
 * classifier filed under a correspondent category. Feeds the unsubscribe denylist.
 */
export function isKnownCorrespondent(db: Database.Database, address: string, domain: string): boolean {
  const placeholders = CORRESPONDENT_CATEGORIES.map(() => '?').join(', ');
  const row = db.prepare(`
    SELECT 1 FROM rfq_messages WHERE vendor_domain = ?
    UNION ALL
    SELECT 1 FROM processed_emails WHERE lower(sender) = ? AND category IN (${placeholders})
    LIMIT 1
  `).get(domain, address.toLowerCase(), ...CORRESPONDENT_CATEGORIES);
  return row !== undefined;
}
