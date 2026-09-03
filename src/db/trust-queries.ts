import type Database from 'better-sqlite3';
import { isPinned } from '../spine/gates.js';
import type { TrustLevel, TrustRow } from '../spine/types.js';

export interface TrustKey { agent: string; brand_id: string; action_type: string }

export function getTrustRow(db: Database.Database, k: TrustKey): TrustRow | undefined {
  return db.prepare(
    'SELECT * FROM trust_ledger WHERE agent = ? AND brand_id = ? AND action_type = ?',
  ).get(k.agent, k.brand_id, k.action_type) as TrustRow | undefined;
}

/** Level 1 when no row exists (spec §4.4: every agent starts at 1). */
export function getTrustLevel(db: Database.Database, k: TrustKey): number {
  return getTrustRow(db, k)?.level ?? 1;
}

function ensureRow(db: Database.Database, k: TrustKey): void {
  db.prepare(`
    INSERT OR IGNORE INTO trust_ledger (agent, brand_id, action_type, level) VALUES (?, ?, ?, 1)
  `).run(k.agent, k.brand_id, k.action_type);
}

/**
 * Count a human decision. A rejection at level >= 2 demotes to 1 (automatic,
 * spec §4.4). Returns whether that happened.
 */
export function recordTrustDecision(
  db: Database.Database,
  k: TrustKey,
  decision: 'approved' | 'approved_with_edit' | 'rejected',
  nowIso: string,
): { demoted: boolean } {
  ensureRow(db, k);
  // `col` is chosen from three literals in code, never from input — the only
  // reason interpolating it into SQL below is safe. Keep it that way.
  const col = decision === 'approved' ? 'approved_as_proposed'
    : decision === 'approved_with_edit' ? 'approved_with_edit' : 'rejected';
  db.prepare(`UPDATE trust_ledger SET ${col} = ${col} + 1, last_change_at = ? WHERE agent = ? AND brand_id = ? AND action_type = ?`)
    .run(nowIso, k.agent, k.brand_id, k.action_type);
  if (decision === 'rejected' && getTrustLevel(db, k) >= 2) {
    db.prepare(`
      UPDATE trust_ledger SET level = 1, last_change_at = ?, last_change_by = 'auto-demote'
      WHERE agent = ? AND brand_id = ? AND action_type = ?
    `).run(nowIso, k.agent, k.brand_id, k.action_type);
    return { demoted: true };
  }
  return { demoted: false };
}

export function promoteTrust(
  db: Database.Database,
  k: TrustKey,
  level: TrustLevel,
  by: string,
  nowIso: string,
): { ok: true; level: number } | { ok: false; reason: 'pinned' | 'out_of_range'; level: number } {
  if (!Number.isInteger(level) || level < 0 || level > 3) {
    return { ok: false, reason: 'out_of_range', level: getTrustLevel(db, k) };
  }
  if (isPinned(k.action_type) && level > 1) {
    return { ok: false, reason: 'pinned', level: getTrustLevel(db, k) };
  }
  ensureRow(db, k);
  db.prepare(`
    UPDATE trust_ledger SET level = ?, last_change_at = ?, last_change_by = ?
    WHERE agent = ? AND brand_id = ? AND action_type = ?
  `).run(level, nowIso, by, k.agent, k.brand_id, k.action_type);
  return { ok: true, level };
}

export function demoteTrust(db: Database.Database, k: TrustKey, by: string, nowIso: string): void {
  ensureRow(db, k);
  db.prepare(`
    UPDATE trust_ledger SET level = 1, last_change_at = ?, last_change_by = ?
    WHERE agent = ? AND brand_id = ? AND action_type = ?
  `).run(nowIso, by, k.agent, k.brand_id, k.action_type);
}

/** Rows touched since `sinceIso` — the monthly summary input. */
export function trustSummarySince(db: Database.Database, sinceIso: string): TrustRow[] {
  return db.prepare(
    'SELECT * FROM trust_ledger WHERE last_change_at >= ? ORDER BY agent, brand_id, action_type',
  ).all(sinceIso) as TrustRow[];
}
