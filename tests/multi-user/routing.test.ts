import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import {
  createUser,
  getUserByTelegramChatId,
} from '../../src/db/user-queries.js';

describe('multi-user telegram routing', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
    createUser(db, { id: 'robert', name: 'Robert', email: 'rob@dd.com', role: 'admin', telegram_chat_id: '111' });
    createUser(db, { id: 'olivier', name: 'Olivier', email: 'olivier@dd.com', role: 'member', telegram_chat_id: '222' });
    createUser(db, { id: 'merab', name: 'Merab', email: 'merab@dd.com', role: 'member', telegram_chat_id: '333' });
  });

  it('should find user by chat_id', () => {
    const user = getUserByTelegramChatId(db, '222');
    expect(user).toBeDefined();
    expect(user!.name).toBe('Olivier');
  });

  it('should return undefined for unknown chat_id', () => {
    const user = getUserByTelegramChatId(db, '999');
    expect(user).toBeUndefined();
  });

  it('should find admin user by chat_id', () => {
    const user = getUserByTelegramChatId(db, '111');
    expect(user).toBeDefined();
    expect(user!.role).toBe('admin');
  });
});
