import type Database from 'better-sqlite3';
import crypto from 'node:crypto';

export interface User {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'member';
  telegram_chat_id: string | null;
  timezone: string;
  briefing_enabled: number;
  briefing_cron: string;
  created_at: string;
  updated_at: string;
}

export interface UserEmailAccount {
  id: string;
  user_id: string;
  email_address: string;
  provider: string;
  enabled: number;
  created_at: string;
}

export interface UserPreferences {
  user_id: string;
  classifier_system_prompt: string | null;
  briefing_system_prompt: string | null;
  business_context: string | null;
  vip_senders: string;
  quiet_categories: string;
  updated_at: string;
}

export interface CreateUserInput {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'member';
  telegram_chat_id?: string;
  timezone?: string;
  briefing_cron?: string;
}

export function createUser(db: Database.Database, input: CreateUserInput): void {
  db.prepare(`
    INSERT INTO users (id, name, email, role, telegram_chat_id, timezone, briefing_cron)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.name,
    input.email,
    input.role,
    input.telegram_chat_id ?? null,
    input.timezone ?? 'America/Chicago',
    input.briefing_cron ?? '0 4 * * 1-5',
  );
}

export function getUserById(db: Database.Database, id: string): User | undefined {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as User | undefined;
}

export function getUserByTelegramChatId(db: Database.Database, chatId: string): User | undefined {
  return db.prepare('SELECT * FROM users WHERE telegram_chat_id = ?').get(chatId) as User | undefined;
}

export function getActiveUsers(db: Database.Database): User[] {
  return db.prepare('SELECT * FROM users WHERE briefing_enabled = 1').all() as User[];
}

export function getAllUsers(db: Database.Database): User[] {
  return db.prepare('SELECT * FROM users').all() as User[];
}

export function addEmailAccount(
  db: Database.Database,
  input: { id: string; user_id: string; email_address: string; provider: string },
): void {
  db.prepare(`
    INSERT INTO user_email_accounts (id, user_id, email_address, provider)
    VALUES (?, ?, ?, ?)
  `).run(input.id, input.user_id, input.email_address, input.provider);
}

export function getUserEmailAccounts(db: Database.Database, userId: string): UserEmailAccount[] {
  return db.prepare(
    'SELECT * FROM user_email_accounts WHERE user_id = ? AND enabled = 1'
  ).all(userId) as UserEmailAccount[];
}

export function getUserPreferences(db: Database.Database, userId: string): UserPreferences | undefined {
  return db.prepare('SELECT * FROM user_preferences WHERE user_id = ?').get(userId) as UserPreferences | undefined;
}

export function setUserPreferences(
  db: Database.Database,
  userId: string,
  prefs: Partial<Omit<UserPreferences, 'user_id' | 'updated_at'>>,
): void {
  const existing = getUserPreferences(db, userId);
  if (!existing) {
    db.prepare(`
      INSERT INTO user_preferences (user_id, business_context, classifier_system_prompt, briefing_system_prompt, vip_senders, quiet_categories)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      userId,
      prefs.business_context ?? null,
      prefs.classifier_system_prompt ?? null,
      prefs.briefing_system_prompt ?? null,
      prefs.vip_senders ?? '[]',
      prefs.quiet_categories ?? '["junk","promotional","newsletter"]',
    );
  } else {
    const fields: string[] = [];
    const values: (string | null)[] = [];
    for (const [key, val] of Object.entries(prefs)) {
      fields.push(`${key} = ?`);
      values.push(val as string | null);
    }
    fields.push("updated_at = datetime('now')");
    values.push(userId);
    db.prepare(`UPDATE user_preferences SET ${fields.join(', ')} WHERE user_id = ?`).run(...values);
  }
}

export function createInvite(db: Database.Database, userId: string): string {
  const code = crypto.randomUUID().slice(0, 8);
  db.prepare(`
    INSERT INTO user_invites (code, user_id, expires_at)
    VALUES (?, ?, datetime('now', '+24 hours'))
  `).run(code, userId);
  return code;
}

export function consumeInvite(db: Database.Database, code: string): string | undefined {
  const invite = db.prepare(`
    SELECT user_id FROM user_invites
    WHERE code = ? AND used_at IS NULL AND expires_at > datetime('now')
  `).get(code) as { user_id: string } | undefined;

  if (!invite) return undefined;

  db.prepare("UPDATE user_invites SET used_at = datetime('now') WHERE code = ?").run(code);
  return invite.user_id;
}

export function linkTelegramChat(db: Database.Database, userId: string, chatId: string): void {
  db.prepare('UPDATE users SET telegram_chat_id = ? WHERE id = ?').run(chatId, userId);
}

export function getAdminUsers(db: Database.Database): User[] {
  return db.prepare("SELECT * FROM users WHERE role = 'admin'").all() as User[];
}
