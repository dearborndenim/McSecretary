import type Database from 'better-sqlite3';

/**
 * OPERATOR direct actions (spec 2026-10-27):
 * - `staff_origin_bots`: each Grok assistant bot registered to one staff user
 *   (users.id) with the action ids it may use. A bot acts only for its person.
 * - `operator_action_audit`: one row per `grok_action` request, unique on
 *   (posted_by, idempotency_key) and (posted_by, request_id), holding the
 *   person, the bot, the poster's request_id, the action, params, the limit
 *   check, the hand's answer and the status.
 */
const AUDIT_COLUMNS = `
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      received_at TEXT NOT NULL,
      finished_at TEXT,
      idempotency_key TEXT NOT NULL,
      request_id TEXT NOT NULL,
      event_id INTEGER,
      posted_by TEXT NOT NULL,
      via TEXT NOT NULL,
      person TEXT,
      user_id TEXT,
      origin_bot TEXT,
      action TEXT NOT NULL,
      params_json TEXT NOT NULL DEFAULT '{}',
      operator_check_json TEXT,
      limit_check_json TEXT,
      hand_status INTEGER,
      hand_response TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      reason TEXT,
      flags_json TEXT,
      result_event_id INTEGER,
      escalation_event_id INTEGER`;
const AUDIT_COLUMN_NAMES = 'id, received_at, finished_at, idempotency_key, request_id, event_id, posted_by, via, person, user_id, origin_bot, action, params_json, operator_check_json, limit_check_json, hand_status, hand_response, status, reason, flags_json, result_event_id, escalation_event_id';

/**
 * The first schema had idempotency_key UNIQUE across every key, so one key
 * could pre-claim another's idempotency_key. SQLite cannot drop a column
 * constraint, so the table is rebuilt once (rows and ids kept) without it;
 * the composite (posted_by, idempotency_key) index replaces it.
 */
function dropGlobalKeyUnique(db: Database.Database): void {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'operator_action_audit'").get() as { sql: string } | undefined;
  if (!row || !/idempotency_key\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(row.sql)) return;
  db.transaction(() => {
    db.exec(`
      CREATE TABLE operator_action_audit_new (${AUDIT_COLUMNS});
      INSERT INTO operator_action_audit_new (${AUDIT_COLUMN_NAMES}) SELECT ${AUDIT_COLUMN_NAMES} FROM operator_action_audit;
      DROP TABLE operator_action_audit;
      ALTER TABLE operator_action_audit_new RENAME TO operator_action_audit;
    `);
  })();
}

export function initializeOperatorSchema(db: Database.Database): void {
  dropGlobalKeyUnique(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS staff_origin_bots (
      bot TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      actions_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS operator_action_audit (${AUDIT_COLUMNS}
    );
    CREATE INDEX IF NOT EXISTS idx_operator_action_audit_received ON operator_action_audit (received_at);
    -- One run per key's idempotency_key; another key's same string is a different request.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_operator_action_audit_key ON operator_action_audit (posted_by, idempotency_key);
    -- One run per OPERATOR request: a resend under a new idempotency_key is still the same request.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_operator_action_audit_request ON operator_action_audit (posted_by, request_id);
  `);
}

// ── origin bots ───────────────────────────────────────────────

export interface OriginBotRow {
  bot: string;
  user_id: string;
  actions_json: string;
  created_at: string;
  updated_at: string;
}

export function originBotActions(row: Pick<OriginBotRow, 'actions_json'>): string[] {
  try {
    const v: unknown = JSON.parse(row.actions_json);
    return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

export function getOriginBot(db: Database.Database, bot: string): OriginBotRow | undefined {
  return db.prepare('SELECT * FROM staff_origin_bots WHERE bot = ?').get(bot) as OriginBotRow | undefined;
}

export function listOriginBots(db: Database.Database): (OriginBotRow & { user_name: string | null; user_email: string | null })[] {
  return db.prepare(`
    SELECT b.*, u.name AS user_name, u.email AS user_email
    FROM staff_origin_bots b LEFT JOIN users u ON u.id = b.user_id ORDER BY b.bot
  `).all() as (OriginBotRow & { user_name: string | null; user_email: string | null })[];
}

/** Insert or replace a bot's registration (person and action list). */
export function upsertOriginBot(db: Database.Database, bot: string, userId: string, actions: string[], nowIso: string): void {
  db.prepare(`
    INSERT INTO staff_origin_bots (bot, user_id, actions_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(bot) DO UPDATE SET user_id = excluded.user_id, actions_json = excluded.actions_json, updated_at = excluded.updated_at
  `).run(bot, userId, JSON.stringify(actions), nowIso, nowIso);
}

export function deleteOriginBot(db: Database.Database, bot: string): boolean {
  return db.prepare('DELETE FROM staff_origin_bots WHERE bot = ?').run(bot).changes > 0;
}

// ── audit ─────────────────────────────────────────────────────

export interface OperatorAuditRow {
  id: number;
  received_at: string;
  finished_at: string | null;
  idempotency_key: string;
  request_id: string;
  event_id: number | null;
  posted_by: string;
  via: string;
  person: string | null;
  user_id: string | null;
  origin_bot: string | null;
  action: string;
  params_json: string;
  operator_check_json: string | null;
  limit_check_json: string | null;
  hand_status: number | null;
  hand_response: string | null;
  status: string;
  reason: string | null;
  flags_json: string | null;
  result_event_id: number | null;
  escalation_event_id: number | null;
}

export function getAuditByKey(db: Database.Database, postedBy: string, key: string): OperatorAuditRow | undefined {
  return db.prepare('SELECT * FROM operator_action_audit WHERE posted_by = ? AND idempotency_key = ?').get(postedBy, key) as OperatorAuditRow | undefined;
}

export function getAuditByRequest(db: Database.Database, postedBy: string, requestId: string): OperatorAuditRow | undefined {
  return db.prepare('SELECT * FROM operator_action_audit WHERE posted_by = ? AND request_id = ?').get(postedBy, requestId) as OperatorAuditRow | undefined;
}

/** Rows still `running` that were received before `beforeIso` (the answer never came back). */
export function listStuckAudit(db: Database.Database, beforeIso: string): OperatorAuditRow[] {
  return db.prepare("SELECT * FROM operator_action_audit WHERE status = 'running' AND received_at < ? ORDER BY id").all(beforeIso) as OperatorAuditRow[];
}

export function getAuditById(db: Database.Database, id: number): OperatorAuditRow | undefined {
  return db.prepare('SELECT * FROM operator_action_audit WHERE id = ?').get(id) as OperatorAuditRow | undefined;
}

export function insertAudit(db: Database.Database, r: {
  received_at: string; idempotency_key: string; request_id: string; event_id: number; posted_by: string; via: string;
  person: string | null; origin_bot: string | null; action: string; params: unknown; operator_check: unknown;
}): number {
  const res = db.prepare(`
    INSERT INTO operator_action_audit (received_at, idempotency_key, request_id, event_id, posted_by, via, person, origin_bot, action, params_json, operator_check_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    r.received_at, r.idempotency_key, r.request_id, r.event_id, r.posted_by, r.via, r.person, r.origin_bot, r.action,
    JSON.stringify(r.params ?? {}), r.operator_check === undefined ? null : JSON.stringify(r.operator_check),
  );
  return Number(res.lastInsertRowid);
}

export function finishAudit(db: Database.Database, id: number, f: {
  finished_at: string; user_id: string | null; limit_check: unknown; hand_status: number | null; hand_response: string | null;
  status: string; reason: string | null; flags: string[]; result_event_id: number | null; escalation_event_id: number | null;
}): void {
  db.prepare(`
    UPDATE operator_action_audit SET finished_at = ?, user_id = ?, limit_check_json = ?, hand_status = ?, hand_response = ?,
      status = ?, reason = ?, flags_json = ?, result_event_id = ?, escalation_event_id = ?
    WHERE id = ?
  `).run(
    f.finished_at, f.user_id, f.limit_check === undefined || f.limit_check === null ? null : JSON.stringify(f.limit_check),
    f.hand_status, f.hand_response, f.status, f.reason, f.flags.length ? JSON.stringify(f.flags) : null,
    f.result_event_id, f.escalation_event_id, id,
  );
}

export function listRecentAudit(db: Database.Database, limit = 50): OperatorAuditRow[] {
  return db.prepare('SELECT * FROM operator_action_audit ORDER BY id DESC LIMIT ?').all(limit) as OperatorAuditRow[];
}
