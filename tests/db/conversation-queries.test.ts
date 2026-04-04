import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import {
  insertConversationMessage,
  getTodayConversation,
  getConversationCount,
  getRecentConversation,
} from '../../src/db/conversation-queries.js';

describe('conversation queries', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it('inserts and retrieves messages', () => {
    insertConversationMessage(db, '2026-04-04', 'rob', 'Check my emails');
    insertConversationMessage(db, '2026-04-04', 'secretary', 'You have 3 new emails...');

    const messages = getTodayConversation(db, '2026-04-04');
    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe('rob');
    expect(messages[1]!.role).toBe('secretary');
  });

  it('counts messages for a date', () => {
    insertConversationMessage(db, '2026-04-04', 'rob', 'Hello');
    insertConversationMessage(db, '2026-04-04', 'secretary', 'Hi Rob');
    insertConversationMessage(db, '2026-04-05', 'rob', 'Next day');

    expect(getConversationCount(db, '2026-04-04')).toBe(2);
    expect(getConversationCount(db, '2026-04-05')).toBe(1);
  });

  it('returns recent messages in correct order', () => {
    for (let i = 1; i <= 40; i++) {
      insertConversationMessage(db, '2026-04-04', 'rob', `Message ${i}`);
    }

    const recent = getRecentConversation(db, '2026-04-04', 5);
    expect(recent).toHaveLength(5);
    expect(recent[0]!.message).toBe('Message 36');
    expect(recent[4]!.message).toBe('Message 40');
  });

  it('filters by date', () => {
    insertConversationMessage(db, '2026-04-04', 'rob', 'Today');
    insertConversationMessage(db, '2026-04-03', 'rob', 'Yesterday');

    const today = getTodayConversation(db, '2026-04-04');
    expect(today).toHaveLength(1);
    expect(today[0]!.message).toBe('Today');
  });
});
