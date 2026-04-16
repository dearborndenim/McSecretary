import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';

describe('user schema', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
  });

  it('should create users table', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'")
      .all();
    expect(tables).toHaveLength(1);
  });

  it('should create user_email_accounts table', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='user_email_accounts'")
      .all();
    expect(tables).toHaveLength(1);
  });

  it('should create user_preferences table', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='user_preferences'")
      .all();
    expect(tables).toHaveLength(1);
  });

  it('should create user_invites table', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='user_invites'")
      .all();
    expect(tables).toHaveLength(1);
  });

  it('should create dev_requests table', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='dev_requests'")
      .all();
    expect(tables).toHaveLength(1);
  });

  it('should add user_id column to processed_emails', () => {
    const info = db.prepare('PRAGMA table_info(processed_emails)').all() as { name: string }[];
    const colNames = info.map((c) => c.name);
    expect(colNames).toContain('user_id');
  });

  it('should add user_id column to conversation_log', () => {
    const info = db.prepare('PRAGMA table_info(conversation_log)').all() as { name: string }[];
    const colNames = info.map((c) => c.name);
    expect(colNames).toContain('user_id');
  });

  it('should add user_id column to time_log', () => {
    const info = db.prepare('PRAGMA table_info(time_log)').all() as { name: string }[];
    const colNames = info.map((c) => c.name);
    expect(colNames).toContain('user_id');
  });

  it('should add user_id column to calendar_events', () => {
    const info = db.prepare('PRAGMA table_info(calendar_events)').all() as { name: string }[];
    const colNames = info.map((c) => c.name);
    expect(colNames).toContain('user_id');
  });

  it('should add user_id column to agent_runs', () => {
    const info = db.prepare('PRAGMA table_info(agent_runs)').all() as { name: string }[];
    const colNames = info.map((c) => c.name);
    expect(colNames).toContain('user_id');
  });

  it('should add user_id column to audit_log', () => {
    const info = db.prepare('PRAGMA table_info(audit_log)').all() as { name: string }[];
    const colNames = info.map((c) => c.name);
    expect(colNames).toContain('user_id');
  });

  it('should add user_id column to sender_profiles', () => {
    const info = db.prepare('PRAGMA table_info(sender_profiles)').all() as { name: string }[];
    const colNames = info.map((c) => c.name);
    expect(colNames).toContain('user_id');
  });

  it('should add user_id column to weekly_schedule', () => {
    const info = db.prepare('PRAGMA table_info(weekly_schedule)').all() as { name: string }[];
    const colNames = info.map((c) => c.name);
    expect(colNames).toContain('user_id');
  });

  it('should add user_id column to pending_actions', () => {
    const info = db.prepare('PRAGMA table_info(pending_actions)').all() as { name: string }[];
    const colNames = info.map((c) => c.name);
    expect(colNames).toContain('user_id');
  });

  it('should be idempotent', () => {
    // Running schema init twice should not error
    initializeSchema(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'")
      .all();
    expect(tables).toHaveLength(1);
  });
});
