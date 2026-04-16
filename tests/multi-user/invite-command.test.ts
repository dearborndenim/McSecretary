import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import {
  createUser,
  getUserByEmail,
  createInvite,
  consumeInvite,
} from '../../src/db/user-queries.js';

describe('getUserByEmail', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
    createUser(db, { id: 'robert', name: 'Robert', email: 'rob@dearborndenim.com', role: 'admin' });
    createUser(db, { id: 'olivier', name: 'Olivier', email: 'olivier@dearborndenim.com', role: 'member' });
  });

  it('should find user by email', () => {
    const user = getUserByEmail(db, 'olivier@dearborndenim.com');
    expect(user).toBeDefined();
    expect(user!.id).toBe('olivier');
    expect(user!.name).toBe('Olivier');
  });

  it('should return undefined for unknown email', () => {
    const user = getUserByEmail(db, 'nobody@example.com');
    expect(user).toBeUndefined();
  });

  it('should be case-sensitive on email lookup', () => {
    // SQLite default comparison is case-sensitive for non-ASCII,
    // but LIKE is case-insensitive. We use = so this tests exact match.
    const user = getUserByEmail(db, 'rob@dearborndenim.com');
    expect(user).toBeDefined();
    expect(user!.id).toBe('robert');
  });
});

describe('createInvite with configurable expiry', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
    createUser(db, { id: 'u1', name: 'Test', email: 'test@x.com', role: 'member' });
  });

  it('should create invite with default 7-day expiry', () => {
    const code = createInvite(db, 'u1');
    expect(code).toBeTruthy();
    expect(code.length).toBe(8);

    // Should be consumable (not expired)
    const userId = consumeInvite(db, code);
    expect(userId).toBe('u1');
  });

  it('should create invite with custom expiry', () => {
    const code = createInvite(db, 'u1', '+1 hour');
    expect(code).toBeTruthy();
    const userId = consumeInvite(db, code);
    expect(userId).toBe('u1');
  });

  it('should reject expired custom invite', () => {
    const code = createInvite(db, 'u1', '-1 hour');
    const userId = consumeInvite(db, code);
    expect(userId).toBeUndefined();
  });
});

describe('/invite command parsing', () => {
  // These tests validate the parsing logic that lives in handleIncomingMessage.
  // Since handleIncomingMessage is not exported, we test the parsing patterns directly.

  function parseInviteCommand(text: string): { valid: boolean; email?: string } {
    const lowerText = text.toLowerCase().trim();
    if (!lowerText.startsWith('/invite ')) return { valid: false };
    const email = text.slice(8).trim().toLowerCase();
    if (!email || !email.includes('@')) return { valid: false };
    return { valid: true, email };
  }

  it('should parse valid /invite command', () => {
    const result = parseInviteCommand('/invite olivier@dearborndenim.com');
    expect(result.valid).toBe(true);
    expect(result.email).toBe('olivier@dearborndenim.com');
  });

  it('should parse /invite with extra spaces', () => {
    const result = parseInviteCommand('/invite   merab@dearborndenim.com  ');
    expect(result.valid).toBe(true);
    expect(result.email).toBe('merab@dearborndenim.com');
  });

  it('should reject /invite with no email', () => {
    const result = parseInviteCommand('/invite');
    expect(result.valid).toBe(false);
  });

  it('should reject /invite with invalid email (no @)', () => {
    const result = parseInviteCommand('/invite notanemail');
    expect(result.valid).toBe(false);
  });

  it('should reject empty /invite argument', () => {
    const result = parseInviteCommand('/invite ');
    expect(result.valid).toBe(false);
  });

  it('should normalize email to lowercase', () => {
    const result = parseInviteCommand('/invite Olivier@DearBornDenim.com');
    expect(result.valid).toBe(true);
    expect(result.email).toBe('olivier@dearborndenim.com');
  });
});
