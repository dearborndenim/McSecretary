import type Database from 'better-sqlite3';

export interface ConversationMessage {
  id: number;
  date: string;
  timestamp: string;
  role: string;
  message: string;
  user_id: string;
}

export function insertConversationMessage(
  db: Database.Database,
  userId: string,
  date: string,
  role: 'rob' | 'secretary',
  message: string,
): void {
  db.prepare(`
    INSERT INTO conversation_log (date, role, message, user_id)
    VALUES (?, ?, ?, ?)
  `).run(date, role, message, userId);
}

export function getTodayConversation(
  db: Database.Database,
  userId: string,
  date: string,
  limit: number = 50,
): ConversationMessage[] {
  return db.prepare(`
    SELECT * FROM conversation_log
    WHERE user_id = ? AND date = ?
    ORDER BY id ASC
    LIMIT ?
  `).all(userId, date, limit) as ConversationMessage[];
}

export function getConversationCount(
  db: Database.Database,
  userId: string,
  date: string,
): number {
  const row = db.prepare(`
    SELECT COUNT(*) as count FROM conversation_log WHERE user_id = ? AND date = ?
  `).get(userId, date) as { count: number };
  return row.count;
}

export function getRecentConversation(
  db: Database.Database,
  userId: string,
  date: string,
  limit: number = 30,
): ConversationMessage[] {
  return db.prepare(`
    SELECT * FROM conversation_log
    WHERE user_id = ? AND date = ?
    ORDER BY id DESC
    LIMIT ?
  `).all(userId, date, limit).reverse() as ConversationMessage[];
}
