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
  briefing_sections_json: string | null;
  /** Brand config this user files under (staff access spec §4). */
  brand_id: string;
  /** JSON array of staff group names; read it with getUserGrants. */
  grants_json: string;
  /** Shopify location gid the user works at; null = none. */
  location_id: string | null;
  /** BCP-47 reply language; null = reply in the language the user writes in. */
  language: string | null;
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
  brand_id?: string;
  location_id?: string | null;
  language?: string | null;
}

/**
 * Namespace rule (staff access spec §4): a users.id must never equal an
 * AGENT_KEYS agent name, because the trust ledger and proposals.agent key on
 * that string and a bearer could otherwise file "as" a person. The service
 * registers the keyed agent names here once at boot (src/index.ts, right after
 * parseAgentKeys); a module-level setter keeps every createUser caller (seeds,
 * the admin CLI, tests) unchanged. Until it is called the set is empty, which
 * is the CLI's case: the CLI does not load AGENT_KEYS, and the boot check
 * (assertNoAgentUserCollision) catches any row it creates on the next start.
 */
let _keyedAgentNames: ReadonlySet<string> = new Set();

export function setKeyedAgentNames(names: Iterable<string>): void {
  _keyedAgentNames = new Set(names);
}

export function isKeyedAgentName(id: string): boolean {
  return _keyedAgentNames.has(id);
}

/** Boot check: throws when any keyed agent name is also a users.id. */
export function assertNoAgentUserCollision(db: Database.Database, agentNames: Iterable<string>): void {
  const clash: string[] = [];
  const has = db.prepare('SELECT 1 FROM users WHERE id = ?');
  for (const name of new Set(agentNames)) {
    if (has.get(name)) clash.push(name);
  }
  if (clash.length > 0) {
    throw new Error(`AGENT_KEYS agent name(s) equal a users.id: ${clash.sort().join(', ')} — rename the agent key or the user`);
  }
}

export function createUser(db: Database.Database, input: CreateUserInput): void {
  if (isKeyedAgentName(input.id)) {
    throw new Error(`User id "${input.id}" is an AGENT_KEYS agent name; pick another id`);
  }
  db.prepare(`
    INSERT INTO users (id, name, email, role, telegram_chat_id, timezone, briefing_cron, brand_id, location_id, language)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.name,
    input.email,
    input.role,
    input.telegram_chat_id ?? null,
    input.timezone ?? 'America/Chicago',
    input.briefing_cron ?? '0 4 * * 1-5',
    input.brand_id ?? 'dearborn-denim',
    input.location_id ?? null,
    input.language ?? null,
  );
}

/** The user's staff groups. Garbage or a non-array in grants_json reads as no grants. */
export function getUserGrants(user: Pick<User, 'grants_json'>): string[] {
  try {
    const parsed: unknown = JSON.parse(user.grants_json ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((g): g is string => typeof g === 'string');
  } catch {
    return [];
  }
}

/** Replaces the user's groups (not an append). Caller validates the names. */
export function setUserGrants(db: Database.Database, userId: string, groups: string[]): void {
  const unique = [...new Set(groups)];
  db.prepare("UPDATE users SET grants_json = ?, updated_at = datetime('now') WHERE id = ?")
    .run(JSON.stringify(unique), userId);
}

export function setUserLocation(db: Database.Database, userId: string, locationId: string | null): void {
  db.prepare("UPDATE users SET location_id = ?, updated_at = datetime('now') WHERE id = ?")
    .run(locationId, userId);
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

/**
 * Read the per-user briefing-section preference. Returns:
 *   - `null` when the column is NULL / unset — caller should render ALL
 *     sections (default behavior preserved for every user without an
 *     explicit preference).
 *   - `string[]` of section names when set. The caller is responsible for
 *     validating the section names against VALID_BRIEFING_SECTIONS.
 *
 * Malformed JSON is treated as NULL (defensive: never break the 5 AM
 * briefing path for a single corrupt row).
 */
export function getUserBriefingSections(
  db: Database.Database,
  userId: string,
): string[] | null {
  const user = getUserById(db, userId);
  if (!user || user.briefing_sections_json === null || user.briefing_sections_json === undefined) {
    return null;
  }
  try {
    const parsed = JSON.parse(user.briefing_sections_json);
    if (!Array.isArray(parsed)) return null;
    const strs = parsed.filter((x): x is string => typeof x === 'string');
    return strs.length > 0 ? strs : null;
  } catch {
    return null;
  }
}

/**
 * Write the per-user briefing-section preference. Passing `null` clears the
 * preference so the user reverts to the default (all sections). Callers must
 * validate section names BEFORE calling this helper.
 */
export function setUserBriefingSections(
  db: Database.Database,
  userId: string,
  sections: string[] | null,
): void {
  const value = sections === null ? null : JSON.stringify(sections);
  db.prepare("UPDATE users SET briefing_sections_json = ?, updated_at = datetime('now') WHERE id = ?")
    .run(value, userId);
}

// ============================================================================
// Briefing-sections audit log (2026-04-25, Task 6 — UX polish 3).
//
// Every successful preference write (--set / --reset / --set-all / --clone-from)
// records a row here so the admin can audit who changed what and when. The
// daily 7 AM digest reads this table for ts >= now-24h.
// ============================================================================

export type BriefingSectionsAuditAction =
  | 'set'
  | 'reset'
  | 'set-all'
  | 'clone-from'
  | 'revert';

export interface BriefingSectionsAuditRow {
  id: number;
  ts: string;
  user_name: string;
  action: BriefingSectionsAuditAction;
  source_user: string | null;
  sections_json: string | null;
  actor: string;
}

export interface InsertBriefingSectionsAuditInput {
  ts?: string; // ISO; defaults to current ISO time at row insert
  user_name: string;
  action: BriefingSectionsAuditAction;
  source_user?: string | null;
  sections_json?: string | null;
  actor?: string;
}

/**
 * Insert one audit row. Callers wrap the call in try/catch so a transient
 * audit-write failure never breaks the parent /briefing-sections handler.
 */
export function insertBriefingSectionsAudit(
  db: Database.Database,
  input: InsertBriefingSectionsAuditInput,
): void {
  const ts = input.ts ?? new Date().toISOString();
  db.prepare(
    `INSERT INTO briefing_sections_audit
       (ts, user_name, action, source_user, sections_json, actor)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    ts,
    input.user_name,
    input.action,
    input.source_user ?? null,
    input.sections_json ?? null,
    input.actor ?? 'admin',
  );
}

/**
 * Return audit rows whose `ts` is >= the given ISO cutoff, newest first. Used
 * by the daily 7 AM digest to summarize the last 24h of preference changes.
 */
export function getBriefingSectionsAuditSince(
  db: Database.Database,
  cutoffIso: string,
): BriefingSectionsAuditRow[] {
  return db
    .prepare(
      `SELECT id, ts, user_name, action, source_user, sections_json, actor
       FROM briefing_sections_audit
       WHERE ts >= ?
       ORDER BY ts DESC, id DESC`,
    )
    .all(cutoffIso) as BriefingSectionsAuditRow[];
}

/**
 * Return audit rows for a specific user (case-insensitive name match) whose
 * `ts` is >= the given ISO cutoff, newest first. Used by the
 * `/briefing-sections --history --user=<name> --days=N` admin command.
 *
 * Note: matches by `user_name` column (the display name we logged at insert
 * time), not by user id. The audit table is intentionally name-based so
 * historical rows survive a user-id rotation.
 */
export function getBriefingSectionsAuditForUserSince(
  db: Database.Database,
  userName: string,
  cutoffIso: string,
): BriefingSectionsAuditRow[] {
  return db
    .prepare(
      `SELECT id, ts, user_name, action, source_user, sections_json, actor
       FROM briefing_sections_audit
       WHERE LOWER(user_name) = LOWER(?)
         AND ts >= ?
       ORDER BY ts DESC, id DESC`,
    )
    .all(userName, cutoffIso) as BriefingSectionsAuditRow[];
}

/**
 * Look up one audit row by primary id. Returns `undefined` when no such row
 * exists. Used by the `/briefing-sections --revert --to=<id>` admin command
 * so the handler can validate the target row exists, belongs to the requested
 * user, and is not the most-recent row before applying the revert.
 *
 * Polish 5 (2026-04-27).
 */
export function getBriefingSectionsAuditById(
  db: Database.Database,
  id: number,
): BriefingSectionsAuditRow | undefined {
  const row = db
    .prepare(
      `SELECT id, ts, user_name, action, source_user, sections_json, actor
       FROM briefing_sections_audit
       WHERE id = ?`,
    )
    .get(id) as BriefingSectionsAuditRow | undefined;
  return row;
}

/**
 * Delete audit rows whose `ts` is < the given ISO cutoff. Returns the number
 * of rows deleted. Best-effort retention enforcement — caller wraps in
 * try/catch so a transient failure does not break the parent action.
 */
export function pruneBriefingSectionsAuditOlderThan(
  db: Database.Database,
  cutoffIso: string,
): number {
  const result = db
    .prepare(`DELETE FROM briefing_sections_audit WHERE ts < ?`)
    .run(cutoffIso);
  return Number(result.changes ?? 0);
}
