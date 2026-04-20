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
  check_in_cron: string | null;
  eod_cron: string | null;
  created_at: string;
  updated_at: string;
}

export interface UserScheduleWindows {
  check_in_cron: string;
  eod_cron: string;
}

// Defaults used when no per-user override is stored.
// Admin: 6 AM – 7 PM check-ins, 7 PM end-of-day (Mon-Fri).
// Member: 6 AM – 2 PM on the hour + 2:30 PM end-of-day (Mon-Fri).
export const DEFAULT_ADMIN_CHECK_IN = '0 6-19 * * 1-5';
export const DEFAULT_ADMIN_EOD = '0 19 * * 1-5';
export const DEFAULT_MEMBER_CHECK_IN = '0 6-14 * * 1-5';
export const DEFAULT_MEMBER_EOD = '30 14 * * 1-5';

// "Staff" pending-invite role (used by the bulk onboarding manifest) maps to
// the member schedule window unless `STAFF_SCHEDULE_WINDOW_START/_END` are
// set. Defaults are 7 AM – 1 PM + 1:30 PM EOD — narrower than members because
// staff are typically part-time.
const STAFF_WINDOW_START = 7;
const STAFF_WINDOW_END = 13;
const STAFF_EOD_HOUR = 13;
const STAFF_EOD_MINUTE = 30;

function parseHour(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n < 0 || n > 23) return fallback;
  return n;
}

/**
 * Resolve the default schedule window for a pending-invite role, honoring the
 * `STAFF_SCHEDULE_WINDOW_START` / `STAFF_SCHEDULE_WINDOW_END` env vars for
 * staff. Admin roles always use `DEFAULT_ADMIN_*`. The helper accepts an
 * optional `env` arg so tests can flip values without mutating process.env.
 */
export function resolveScheduleWindowsForRole(
  role: 'admin' | 'staff',
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): UserScheduleWindows {
  if (role === 'admin') {
    return {
      check_in_cron: DEFAULT_ADMIN_CHECK_IN,
      eod_cron: DEFAULT_ADMIN_EOD,
    };
  }
  const start = parseHour(env.STAFF_SCHEDULE_WINDOW_START, STAFF_WINDOW_START);
  const end = parseHour(env.STAFF_SCHEDULE_WINDOW_END, STAFF_WINDOW_END);
  // Ensure start <= end to avoid a malformed cron range.
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  const checkIn = lo === hi ? `0 ${lo} * * 1-5` : `0 ${lo}-${hi} * * 1-5`;
  // EOD defaults to 30 minutes after the last check-in hour unless explicitly
  // configured via end; for overridden end hours we keep the :30 convention.
  const eodHour = hi;
  const eodMinute = env.STAFF_SCHEDULE_WINDOW_END ? STAFF_EOD_MINUTE : STAFF_EOD_MINUTE;
  const eod = `${eodMinute} ${eodHour} * * 1-5`;
  // Preserve legacy default exactly when env is unset.
  if (env.STAFF_SCHEDULE_WINDOW_START === undefined && env.STAFF_SCHEDULE_WINDOW_END === undefined) {
    return {
      check_in_cron: `0 ${STAFF_WINDOW_START}-${STAFF_WINDOW_END} * * 1-5`,
      eod_cron: `${STAFF_EOD_MINUTE} ${STAFF_EOD_HOUR} * * 1-5`,
    };
  }
  return { check_in_cron: checkIn, eod_cron: eod };
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

export function getUserByEmail(db: Database.Database, email: string): User | undefined {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email) as User | undefined;
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

export function createInvite(db: Database.Database, userId: string, expiresIn: string = '+7 days'): string {
  const code = crypto.randomUUID().slice(0, 8);
  db.prepare(`
    INSERT INTO user_invites (code, user_id, expires_at)
    VALUES (?, ?, datetime('now', ?))
  `).run(code, userId, expiresIn);
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

export function setUserScheduleWindows(
  db: Database.Database,
  userId: string,
  windows: Partial<UserScheduleWindows>,
): void {
  const fields: string[] = [];
  const values: (string | null)[] = [];
  if (windows.check_in_cron !== undefined) {
    fields.push('check_in_cron = ?');
    values.push(windows.check_in_cron);
  }
  if (windows.eod_cron !== undefined) {
    fields.push('eod_cron = ?');
    values.push(windows.eod_cron);
  }
  if (fields.length === 0) return;
  fields.push("updated_at = datetime('now')");
  values.push(userId);
  db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

/**
 * Returns the per-user schedule windows, falling back to sensible defaults
 * based on the user's role when the DB values are NULL.
 * Returns undefined if the user doesn't exist.
 */
export function getUserScheduleWindows(
  db: Database.Database,
  userId: string,
): UserScheduleWindows | undefined {
  const user = getUserById(db, userId);
  if (!user) return undefined;
  const isAdmin = user.role === 'admin';
  return {
    check_in_cron: user.check_in_cron ?? (isAdmin ? DEFAULT_ADMIN_CHECK_IN : DEFAULT_MEMBER_CHECK_IN),
    eod_cron: user.eod_cron ?? (isAdmin ? DEFAULT_ADMIN_EOD : DEFAULT_MEMBER_EOD),
  };
}
