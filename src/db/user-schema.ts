import type Database from 'better-sqlite3';

export function initializeUserSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      telegram_chat_id TEXT UNIQUE,
      timezone TEXT NOT NULL DEFAULT 'America/Chicago',
      briefing_enabled INTEGER DEFAULT 1,
      briefing_cron TEXT DEFAULT '0 4 * * 1-5',
      check_in_cron TEXT,
      eod_cron TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS user_email_accounts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      email_address TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'outlook',
      enabled INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(user_id, email_address)
    );

    CREATE TABLE IF NOT EXISTS user_preferences (
      user_id TEXT PRIMARY KEY REFERENCES users(id),
      classifier_system_prompt TEXT,
      briefing_system_prompt TEXT,
      business_context TEXT,
      vip_senders TEXT DEFAULT '[]',
      quiet_categories TEXT DEFAULT '["junk","promotional","newsletter"]',
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS user_invites (
      code TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      created_at TEXT DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      used_at TEXT
    );

    CREATE TABLE IF NOT EXISTS dev_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL REFERENCES users(id),
      project TEXT,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      refined_description TEXT,
      reviewed_by TEXT REFERENCES users(id),
      reviewed_at TEXT,
      rejection_reason TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Add new columns to users table (idempotent)
  const userCols = db.prepare('PRAGMA table_info(users)').all() as { name: string }[];
  const userColNames = new Set(userCols.map((c) => c.name));
  if (!userColNames.has('check_in_cron')) {
    db.exec('ALTER TABLE users ADD COLUMN check_in_cron TEXT');
  }
  if (!userColNames.has('eod_cron')) {
    db.exec('ALTER TABLE users ADD COLUMN eod_cron TEXT');
  }

  // Add synced_at to dev_requests (idempotent)
  const devCols = db.prepare('PRAGMA table_info(dev_requests)').all() as { name: string }[];
  if (!devCols.some((c) => c.name === 'synced_at')) {
    db.exec('ALTER TABLE dev_requests ADD COLUMN synced_at TEXT');
  }

  // Add user_id to existing tables (idempotent — check before ALTER)
  const tablesToAlter = [
    'processed_emails',
    'sender_profiles',
    'agent_runs',
    'audit_log',
    'calendar_events',
    'weekly_schedule',
    'pending_actions',
    'time_log',
    'conversation_log',
  ];

  for (const table of tablesToAlter) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    const hasUserId = cols.some((c) => c.name === 'user_id');
    if (!hasUserId) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN user_id TEXT REFERENCES users(id)`);
    }
  }
}
