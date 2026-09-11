import type Database from 'better-sqlite3';
import { hashPayload } from '../spine/payload-hash.js';
import type { ActionPayload, ProposalInput, ProposalRow, ProposalStatus } from '../spine/types.js';

// Timestamps are compared as strings; every stored timestamp must be Date#toISOString() format.
// insertProposal normalises expires_at; nowIso callers must pass toISOString() output.

const LIVE_STATUSES = "('pending','approved','approved_with_edit','executed')";

/**
 * Insert a proposal. If an identical live proposal (same agent, brand,
 * action_type, payload hash; status live; not yet expired) exists, return its
 * id with `deduped: true` and insert nothing.
 */
export function insertProposal(
  db: Database.Database,
  input: ProposalInput,
  nowIso: string,
): { id: number; deduped: boolean } {
  const expiresMs = Date.parse(input.expires_at);
  if (Number.isNaN(expiresMs)) throw new Error(`Invalid expires_at: ${input.expires_at}`);
  const expiresAt = new Date(expiresMs).toISOString();

  const payload_hash = hashPayload(input.action_payload);
  const existing = db.prepare(`
    SELECT id FROM proposals
    WHERE agent = ? AND brand_id = ? AND action_type = ? AND payload_hash = ?
      AND status IN ${LIVE_STATUSES} AND expires_at > ?
    ORDER BY id DESC LIMIT 1
  `).get(input.agent, input.brand_id, input.action_type, payload_hash, nowIso) as { id: number } | undefined;
  if (existing) return { id: existing.id, deduped: true };

  const result = db.prepare(`
    INSERT INTO proposals
      (agent, brand_id, action_type, action_payload, payload_hash, reason, evidence,
       cost_usd, reversible, level_required, status, created_at, expires_at, run_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
  `).run(
    input.agent, input.brand_id, input.action_type, JSON.stringify(input.action_payload), payload_hash,
    input.reason, JSON.stringify(input.evidence), input.cost_usd, input.reversible ? 1 : 0,
    input.level_required, nowIso, expiresAt, input.run_id ?? null,
  );
  return { id: Number(result.lastInsertRowid), deduped: false };
}

export function getProposalById(db: Database.Database, id: number): ProposalRow | undefined {
  return db.prepare('SELECT * FROM proposals WHERE id = ?').get(id) as ProposalRow | undefined;
}

export function listPendingProposals(db: Database.Database): ProposalRow[] {
  return db.prepare(
    "SELECT * FROM proposals WHERE status = 'pending' ORDER BY created_at ASC, id ASC",
  ).all() as ProposalRow[];
}

/** Newest first, any status — what `read_agent_outputs` shows Robert. */
export function listProposalsByAgent(
  db: Database.Database, agent: string, brandId: string, limit: number,
): ProposalRow[] {
  return db.prepare(
    'SELECT * FROM proposals WHERE agent = ? AND brand_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
  ).all(agent, brandId, limit) as ProposalRow[];
}

/**
 * Record a human decision. Only a `pending` row can be decided; returns false
 * (no-op) when the row is missing or not pending.
 */
export function decideProposal(
  db: Database.Database,
  id: number,
  status: Extract<ProposalStatus, 'approved' | 'approved_with_edit' | 'rejected'>,
  decidedBy: string,
  nowIso: string,
): boolean {
  const result = db.prepare(`
    UPDATE proposals SET status = ?, decided_by = ?, decided_at = ?, edit_requested_at = NULL
    WHERE id = ? AND status = 'pending'
  `).run(status, decidedBy, nowIso, id);
  return result.changes === 1;
}

/**
 * Record the outcome of calling the hand. Only a pending/approved/
 * approved_with_edit row can be executed; returns false (no-op) otherwise.
 */
export function recordExecution(
  db: Database.Database,
  id: number,
  status: Extract<ProposalStatus, 'executed' | 'failed'>,
  result: Record<string, unknown>,
): boolean {
  const r = db.prepare(`
    UPDATE proposals SET status = ?, execution_result = ?
    WHERE id = ? AND status IN ('pending','approved','approved_with_edit')
  `).run(status, JSON.stringify(result), id);
  return r.changes === 1;
}

/** Expire pending proposals past their expiry. Returns the rows that were expired. */
export function expireProposals(db: Database.Database, nowIso: string): ProposalRow[] {
  const rows = db.prepare(
    "SELECT * FROM proposals WHERE status = 'pending' AND expires_at <= ? ORDER BY id ASC",
  ).all(nowIso) as ProposalRow[];
  if (rows.length === 0) return [];
  const stmt = db.prepare("UPDATE proposals SET status = 'expired' WHERE id = ?");
  for (const r of rows) stmt.run(r.id);
  return rows.map((r) => ({ ...r, status: 'expired' as const }));
}

export function setTelegramRef(db: Database.Database, id: number, chatId: string, messageId: number): void {
  db.prepare('UPDATE proposals SET telegram_chat_id = ?, telegram_message_id = ? WHERE id = ?')
    .run(chatId, messageId, id);
}

/**
 * Mark a pending row as awaiting an edit reply. Returns false (no-op) when the
 * row is missing or not pending.
 */
export function setEditRequested(db: Database.Database, id: number, nowIso: string): boolean {
  const result = db.prepare(
    "UPDATE proposals SET edit_requested_at = ? WHERE id = ? AND status = 'pending'",
  ).run(nowIso, id);
  return result.changes === 1;
}

/** Drop the edit-requested flag on a pending row (cancel / stale window). */
export function clearEditRequested(db: Database.Database, id: number): void {
  db.prepare("UPDATE proposals SET edit_requested_at = NULL WHERE id = ? AND status = 'pending'").run(id);
}

/**
 * Drop the edit-requested flag on every other pending proposal in this chat,
 * so a chat is never waiting on two edit replies at once.
 */
export function clearEditRequestedForChat(db: Database.Database, chatId: string, exceptId: number): void {
  db.prepare(
    "UPDATE proposals SET edit_requested_at = NULL WHERE telegram_chat_id = ? AND status = 'pending' AND id != ?",
  ).run(chatId, exceptId);
}

/** The most recent pending proposal in this chat awaiting an edit reply, if any. */
export function findEditRequestedForChat(db: Database.Database, chatId: string): ProposalRow | undefined {
  return db.prepare(`
    SELECT * FROM proposals
    WHERE telegram_chat_id = ? AND status = 'pending' AND edit_requested_at IS NOT NULL
    ORDER BY edit_requested_at DESC, id DESC LIMIT 1
  `).get(chatId) as ProposalRow | undefined;
}

export function appendEdit(db: Database.Database, id: number, edit: { at: string; note: string }): void {
  const row = getProposalById(db, id);
  if (!row) return;
  const edits = row.edits ? (JSON.parse(row.edits) as unknown[]) : [];
  edits.push(edit);
  db.prepare('UPDATE proposals SET edits = ? WHERE id = ?').run(JSON.stringify(edits), id);
}

/**
 * Replace the payload and keep `payload_hash` in step so dedupe sees the
 * edited action. Only a `pending` row can be edited; returns false (no-op)
 * when the row is missing or already decided.
 */
export function updateActionPayload(db: Database.Database, id: number, payload: ActionPayload): boolean {
  const result = db.prepare(
    "UPDATE proposals SET action_payload = ?, payload_hash = ? WHERE id = ? AND status = 'pending'",
  ).run(JSON.stringify(payload), hashPayload(payload), id);
  return result.changes === 1;
}
