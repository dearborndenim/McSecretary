/**
 * Read-only admin views for the Mac mini (GET /spine/admin/*): the Telegram
 * approval cards (proposals), what people said to McSecretary
 * (conversation_log) and audit_log. Granted only by an AGENT_POLICY entry with
 * `admin_read: true` (the route check lives in api-routes.ts).
 *
 * Redaction, applied to everything returned:
 * - inside parsed JSON (evidence, action_payload, edits, execution_result,
 *   audit details): the value of any key matching SECRET_KEY_RE becomes
 *   "[redacted]"; a whole string value that looks like a bare credential
 *   (BARE_TOKEN_RE: 32+ chars of [A-Za-z0-9_-+/=.], no spaces, mixing letters
 *   and digits) becomes "[redacted]" unless its key names an id or hash;
 * - in every string, free text included: known credential shapes
 *   (sk-…, ghp_…, xox?-…, shpat_…, AKIA…, JWTs, "Bearer x", "password=x" …)
 *   are replaced in place;
 * - any string over STRING_CAP chars is cut and marked.
 */
import type Database from 'better-sqlite3';
import { getUserById } from '../db/user-queries.js';
import { renderProposalCard } from './telegram-card.js';
import type { ProposalRow } from './types.js';

export const ADMIN_READ_DEFAULT_LIMIT = 200;
export const ADMIN_READ_MAX_LIMIT = 1000;
export const STRING_CAP = 8000;
const REDACTED = '[redacted]';

const SECRET_KEY_RE = /key|token|secret|password|authorization|bearer|cookie|code_hash/i;
/** Keys whose long opaque values are identifiers, not credentials (Graph message ids, sha256s). */
const ID_KEY_RE = /(^|_|-)(id|ids|sha256|hash)$|Id$/i;
const BARE_TOKEN_RE = /^[A-Za-z0-9_\-+/=.]{32,}$/;
const INLINE_PATTERNS: Array<[RegExp, string]> = [
  [/\b(bearer|basic)\s+[A-Za-z0-9_\-+/=.~]{8,}/gi, `$1 ${REDACTED}`],
  [/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|client[_-]?secret)(\s*[:=]\s*)("?)[^\s"',;&]+/gi, `$1$2$3${REDACTED}`],
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{16,}/g, REDACTED],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\b(?:shpat|shpss|shpca|shppa)_[A-Fa-f0-9]{16,}/g, REDACTED],
  [/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g, REDACTED],
  [/\bAKIA[A-Z0-9]{16}\b/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/\b\d{8,10}:AA[A-Za-z0-9_-]{30,}/g, REDACTED], // Telegram bot token
];

function looksLikeBareToken(s: string): boolean {
  return BARE_TOKEN_RE.test(s) && /[A-Za-z]/.test(s) && /\d/.test(s);
}

/** Inline credential shapes replaced, then capped at STRING_CAP. */
export function redactText(s: string): string {
  let out = s;
  for (const [re, rep] of INLINE_PATTERNS) out = out.replace(re, rep);
  if (out.length > STRING_CAP) out = `${out.slice(0, STRING_CAP)}…[truncated ${out.length - STRING_CAP} chars]`;
  return out;
}

/** Deep copy of a parsed JSON value with secrets redacted (see the module comment). */
export function redactValue(v: unknown, key: string | null = null): unknown {
  if (key !== null && SECRET_KEY_RE.test(key) && v !== null && v !== undefined) return REDACTED;
  if (typeof v === 'string') {
    if (!(key !== null && ID_KEY_RE.test(key)) && looksLikeBareToken(v)) return REDACTED;
    return redactText(v);
  }
  if (Array.isArray(v)) return v.map((x) => redactValue(x, null));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = redactValue(x, k);
    return out;
  }
  return v;
}

/** A stored JSON column, parsed and redacted; unparseable text comes back as redacted text. */
function jsonColumn(raw: string | null): unknown {
  if (raw === null || raw === undefined) return null;
  try {
    return redactValue(JSON.parse(raw));
  } catch {
    return redactText(raw);
  }
}

function textOrNull(s: string | null): string | null {
  return s === null || s === undefined ? null : redactText(s);
}

/** SQLite datetime('now') text ("YYYY-MM-DD HH:MM:SS", UTC) for an ISO `since`. */
function sqliteTime(iso: string): string {
  return iso.slice(0, 19).replace('T', ' ');
}

export interface AdminProposalFilter { since: string | null; limit: number; status: string | null; id: number | null }

export function listAdminProposals(db: Database.Database, f: AdminProposalFilter): Record<string, unknown>[] {
  const rows = db.prepare(`
    SELECT * FROM proposals
    WHERE (? IS NULL OR created_at >= ?) AND (? IS NULL OR status = ?) AND (? IS NULL OR id = ?)
    ORDER BY id DESC
    LIMIT ?
  `).all(f.since, f.since, f.status, f.status, f.id, f.id, f.limit) as ProposalRow[];
  return rows.map((p) => {
    let card: string | null = null;
    try {
      card = redactText(renderProposalCard(p, getUserById(db, p.agent) !== undefined));
    } catch {
      card = null;
    }
    return {
      id: p.id,
      agent: p.agent,
      brand_id: p.brand_id,
      action_type: p.action_type,
      reason: redactText(p.reason),
      evidence: jsonColumn(p.evidence),
      action_payload: jsonColumn(p.action_payload),
      cost_usd: p.cost_usd,
      reversible: p.reversible === 1,
      level_required: p.level_required,
      status: p.status,
      created_at: p.created_at,
      expires_at: p.expires_at,
      decided_by: p.decided_by,
      decided_at: p.decided_at,
      edits: jsonColumn(p.edits),
      execution_result: jsonColumn(p.execution_result),
      run_id: p.run_id,
      card_text: card,
    };
  });
}

export function listAdminConversations(
  db: Database.Database, f: { since: string | null; limit: number; user_id: string | null },
): Record<string, unknown>[] {
  const since = f.since === null ? null : sqliteTime(f.since);
  const rows = db.prepare(`
    SELECT id, user_id, date, timestamp, role, message FROM conversation_log
    WHERE (? IS NULL OR timestamp >= ?) AND (? IS NULL OR user_id = ?)
    ORDER BY id DESC
    LIMIT ?
  `).all(since, since, f.user_id, f.user_id, f.limit) as Array<{ message: string } & Record<string, unknown>>;
  return rows.map((r) => ({ ...r, message: redactText(r.message) }));
}

export function listAdminAudit(db: Database.Database, f: { since: string | null; limit: number }): Record<string, unknown>[] {
  const since = f.since === null ? null : sqliteTime(f.since);
  const rows = db.prepare(`
    SELECT id, timestamp, user_id, action_type, target_id, target_type, details, confidence, approved_by, was_reversed
    FROM audit_log
    WHERE (? IS NULL OR timestamp >= ?)
    ORDER BY id DESC
    LIMIT ?
  `).all(since, since, f.limit) as Array<{ details: string | null; target_id: string | null; was_reversed: number } & Record<string, unknown>>;
  return rows.map((r) => ({
    ...r,
    target_id: textOrNull(r.target_id),
    details: jsonColumn(r.details),
    was_reversed: r.was_reversed === 1,
  }));
}
