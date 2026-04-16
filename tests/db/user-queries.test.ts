import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import {
  createUser,
  getUserById,
  getUserByTelegramChatId,
  getActiveUsers,
  getUserEmailAccounts,
  addEmailAccount,
  getUserPreferences,
  setUserPreferences,
  createInvite,
  consumeInvite,
  linkTelegramChat,
} from '../../src/db/user-queries.js';
import crypto from 'node:crypto';

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

describe('user CRUD', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
  });

  it('should create a user and retrieve by id', () => {
    const id = crypto.randomUUID();
    createUser(db, { id, name: 'Robert', email: 'rob@dearborndenim.com', role: 'admin' });
    const user = getUserById(db, id);
    expect(user).toBeDefined();
    expect(user!.name).toBe('Robert');
    expect(user!.role).toBe('admin');
    expect(user!.timezone).toBe('America/Chicago');
    expect(user!.briefing_enabled).toBe(1);
  });

  it('should retrieve user by telegram_chat_id', () => {
    const id = crypto.randomUUID();
    createUser(db, { id, name: 'Robert', email: 'rob@dd.com', role: 'admin', telegram_chat_id: '12345' });
    const user = getUserByTelegramChatId(db, '12345');
    expect(user).toBeDefined();
    expect(user!.id).toBe(id);
  });

  it('should return undefined for unknown chat_id', () => {
    const user = getUserByTelegramChatId(db, '99999');
    expect(user).toBeUndefined();
  });

  it('should list active users with briefing_enabled', () => {
    createUser(db, { id: 'u1', name: 'A', email: 'a@x.com', role: 'member' });
    createUser(db, { id: 'u2', name: 'B', email: 'b@x.com', role: 'member' });
    db.prepare('UPDATE users SET briefing_enabled = 0 WHERE id = ?').run('u2');
    const active = getActiveUsers(db);
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe('u1');
  });

  it('should add and retrieve email accounts for a user', () => {
    createUser(db, { id: 'u1', name: 'A', email: 'a@x.com', role: 'member' });
    addEmailAccount(db, { id: 'ea1', user_id: 'u1', email_address: 'a@x.com', provider: 'outlook' });
    addEmailAccount(db, { id: 'ea2', user_id: 'u1', email_address: 'a2@x.com', provider: 'outlook' });
    const accounts = getUserEmailAccounts(db, 'u1');
    expect(accounts).toHaveLength(2);
  });

  it('should set and get user preferences', () => {
    createUser(db, { id: 'u1', name: 'A', email: 'a@x.com', role: 'member' });
    setUserPreferences(db, 'u1', { business_context: 'Manages operations at DD' });
    const prefs = getUserPreferences(db, 'u1');
    expect(prefs).toBeDefined();
    expect(prefs!.business_context).toBe('Manages operations at DD');
  });

  it('should create and consume an invite', () => {
    createUser(db, { id: 'u1', name: 'A', email: 'a@x.com', role: 'member' });
    const code = createInvite(db, 'u1');
    expect(code).toBeTruthy();

    const userId = consumeInvite(db, code);
    expect(userId).toBe('u1');

    // Second use should fail
    const again = consumeInvite(db, code);
    expect(again).toBeUndefined();
  });

  it('should reject expired invite', () => {
    createUser(db, { id: 'u1', name: 'A', email: 'a@x.com', role: 'member' });
    const code = 'expired-code';
    db.prepare(
      "INSERT INTO user_invites (code, user_id, expires_at) VALUES (?, ?, datetime('now', '-1 hour'))"
    ).run(code, 'u1');
    const userId = consumeInvite(db, code);
    expect(userId).toBeUndefined();
  });

  it('should link telegram chat to user via invite', () => {
    createUser(db, { id: 'u1', name: 'A', email: 'a@x.com', role: 'member' });
    const code = createInvite(db, 'u1');
    linkTelegramChat(db, 'u1', '67890');
    const user = getUserByTelegramChatId(db, '67890');
    expect(user).toBeDefined();
    expect(user!.id).toBe('u1');
  });
});
