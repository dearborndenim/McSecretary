import type Database from 'better-sqlite3';
import { initializeCalendarSchema } from './calendar-schema.js';

export function initializeSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS processed_emails (
      id TEXT PRIMARY KEY,
      account TEXT NOT NULL,
      sender TEXT,
      sender_name TEXT,
      subject TEXT,
      received_at TEXT,
      processed_at TEXT DEFAULT (datetime('now')),
      category TEXT,
      urgency TEXT,
      action_needed TEXT,
      action_taken TEXT,
      confidence REAL,
      summary TEXT,
      thread_id TEXT,
      project_id TEXT
    );

    CREATE TABLE IF NOT EXISTS sender_profiles (
      email TEXT PRIMARY KEY,
      name TEXT,
      organization TEXT,
      default_category TEXT,
      default_urgency TEXT,
      total_emails INTEGER DEFAULT 0,
      last_seen TEXT,
      is_vip INTEGER DEFAULT 0,
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS agent_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT,
      completed_at TEXT,
      run_type TEXT,
      emails_processed INTEGER DEFAULT 0,
      actions_taken INTEGER DEFAULT 0,
      errors TEXT,
      tokens_used INTEGER DEFAULT 0,
      cost_estimate REAL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT DEFAULT (datetime('now')),
      action_type TEXT,
      target_id TEXT,
      target_type TEXT,
      details TEXT,
      confidence REAL,
      approved_by TEXT,
      was_reversed INTEGER DEFAULT 0
    );
  `);

  initializeCalendarSchema(db);
}
