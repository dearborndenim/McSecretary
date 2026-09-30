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
