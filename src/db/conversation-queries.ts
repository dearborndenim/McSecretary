import type Database from 'better-sqlite3';

export interface ConversationMessage {
  id: number;
  date: string;
  timestamp: string;
  role: string;
  message: string;
}

export function insertConversationMessage(
  db: Database.Database,
  date: string,
  role: 'rob' | 'secretary',
  message: string,
): void {
  db.prepare(`
    INSERT INTO conversation_log (date, role, message)
    VALUES (?, ?, ?)
  `).run(date, role, message);
}

export function getTodayConversation(
  db: Database.Database,
  date: string,
  limit: number = 50,
): ConversationMessage[] {
  return db.prepare(`
    SELECT * FROM conversation_log
    WHERE date = ?
    ORDER BY id ASC
    LIMIT ?
  `).all(date, limit) as ConversationMessage[];
}

export function getConversationCount(
  db: Database.Database,
  date: string,
): number {
  const row = db.prepare(`
    SELECT COUNT(*) as count FROM conversation_log WHERE date = ?
  `).get(date) as { count: number };
  return row.count;
}

export function getRecentConversation(
  db: Database.Database,
  date: string,
  limit: number = 30,
): ConversationMessage[] {
  return db.prepare(`
    SELECT * FROM conversation_log
    WHERE date = ?
    ORDER BY id DESC
    LIMIT ?
  `).all(date, limit).reverse() as ConversationMessage[];
}
