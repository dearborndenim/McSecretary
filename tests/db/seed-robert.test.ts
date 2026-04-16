import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import { seedRobert } from '../../src/db/seed-robert.js';
import { getUserById, getUserEmailAccounts, getUserPreferences } from '../../src/db/user-queries.js';

describe('seed Robert', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
  });

  it('should create Robert as admin', () => {
    seedRobert(db, '12345');
    const user = getUserById(db, 'robert-mcmillan');
    expect(user).toBeDefined();
    expect(user!.role).toBe('admin');
    expect(user!.telegram_chat_id).toBe('12345');
  });

  it('should create two email accounts for Robert', () => {
    seedRobert(db, '12345');
    const accounts = getUserEmailAccounts(db, 'robert-mcmillan');
    expect(accounts).toHaveLength(2);
    const emails = accounts.map((a) => a.email_address).sort();
    expect(emails).toEqual(['rob@dearborndenim.com', 'robert@mcmillan-manufacturing.com']);
  });

  it('should set Robert business context', () => {
    seedRobert(db, '12345');
    const prefs = getUserPreferences(db, 'robert-mcmillan');
    expect(prefs).toBeDefined();
    expect(prefs!.business_context).toContain('Dearborn Denim');
    expect(prefs!.business_context).toContain('McMillan Manufacturing');
  });

  it('should backfill user_id on existing data', () => {
    // Insert some data without user_id
    db.prepare("INSERT INTO processed_emails (id, account, sender) VALUES ('e1', 'rob@dd.com', 'test@x.com')").run();
    db.prepare("INSERT INTO conversation_log (date, role, message) VALUES ('2026-04-16', 'rob', 'hello')").run();

    seedRobert(db, '12345');

    const email = db.prepare('SELECT user_id FROM processed_emails WHERE id = ?').get('e1') as { user_id: string };
    expect(email.user_id).toBe('robert-mcmillan');

    const conv = db.prepare('SELECT user_id FROM conversation_log WHERE id = 1').get() as { user_id: string };
    expect(conv.user_id).toBe('robert-mcmillan');
  });

  it('should be idempotent', () => {
    seedRobert(db, '12345');
    seedRobert(db, '12345'); // no error
    const accounts = getUserEmailAccounts(db, 'robert-mcmillan');
    expect(accounts).toHaveLength(2);
  });
});
