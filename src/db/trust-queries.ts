import type Database from 'better-sqlite3';
import { isPinned } from '../spine/gates.js';
import type { TrustLevel, TrustRow } from '../spine/types.js';

export interface TrustKey { agent: string; brand_id: string; action_type: string }

export function getTrustRow(db: Database.Database, k: TrustKey): TrustRow | undefined {
  return db.prepare(
    'SELECT * FROM trust_ledger WHERE agent = ? AND brand_id = ? AND action_type = ?',
  ).get(k.agent, k.brand_id, k.action_type) as TrustRow | undefined;
}

/** The one wildcard token in a ledger row's `agent` or `action_type`. No globs. */
export const TRUST_WILDCARD = '*';

/**
 * The effective level for a key (spec §4.4 plus wildcard rows). First match wins:
 * 1. the exact row (agent, brand, action_type)
 * 2. (agent, brand, '*')
 * 3. ('*', brand, action_type)
 * 4. ('*', brand, '*')
 * 5. level 1 (every agent starts at 1)
 * A pinned action type (§6) never resolves above 1, whatever any wildcard row
 * says: wildcards never lift a human gate. An exact pinned row below 1 (level 0)
 * keeps its level.
 */
export function getTrustLevel(db: Database.Database, k: TrustKey): number {
  const exact = getTrustRow(db, k);
  if (isPinned(k.action_type)) return Math.min(exact?.level ?? 1, 1);
  if (exact) return exact.level;
  const W = TRUST_WILDCARD;
  const candidates: Array<[string, string]> = [[k.agent, W], [W, k.action_type], [W, W]];
  for (const [agent, action_type] of candidates) {
    const row = getTrustRow(db, { agent, brand_id: k.brand_id, action_type });
    if (row) return row.level;
  }
  return 1;
}

/**
 * Create the exact row when missing, seeded at the currently effective level
 * (wildcard- and pin-aware), so counting a decision on a key covered by a
 * wildcard never silently lowers its level.
 */
function ensureRow(db: Database.Database, k: TrustKey): void {
  if (getTrustRow(db, k)) return;
  const level = getTrustLevel(db, k);
  db.prepare(`
    INSERT OR IGNORE INTO trust_ledger (agent, brand_id, action_type, level) VALUES (?, ?, ?, ?)
  `).run(k.agent, k.brand_id, k.action_type, level);
}

/**
 * Create the ledger row at `level` when none exists yet (a staff user's first
 * filing of an action type, catalogue `initial_level`; staff admin UI spec §4).
 * An existing row is never touched. A pinned type always starts at 1.
 * Returns whether a row was created.
 */
export function ensureInitialTrust(db: Database.Database, k: TrustKey, level: 1 | 2 | 3, nowIso: string): boolean {
  const start = isPinned(k.action_type) ? 1 : level;
  const r = db.prepare(`
    INSERT OR IGNORE INTO trust_ledger (agent, brand_id, action_type, level, last_change_at, last_change_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(k.agent, k.brand_id, k.action_type, start, start > 1 ? nowIso : null, start > 1 ? 'catalogue' : null);
  return r.changes === 1;
}

/**
 * Count a human decision on the exact row. A rejection at an effective level
 * >= 2 (exact or wildcard) writes the exact row to 1 (automatic, spec §4.4).
 * Returns whether that happened.
 */
export function recordTrustDecision(
  db: Database.Database,
  k: TrustKey,
  decision: 'approved' | 'approved_with_edit' | 'rejected',
  nowIso: string,
): { demoted: boolean } {
  const effective = getTrustLevel(db, k);
  ensureRow(db, k);
  // `col` is chosen from three literals in code, never from input — the only
  // reason interpolating it into SQL below is safe. Keep it that way.
  const col = decision === 'approved' ? 'approved_as_proposed'
    : decision === 'approved_with_edit' ? 'approved_with_edit' : 'rejected';
  db.prepare(`UPDATE trust_ledger SET ${col} = ${col} + 1, last_change_at = ? WHERE agent = ? AND brand_id = ? AND action_type = ?`)
    .run(nowIso, k.agent, k.brand_id, k.action_type);
  if (decision === 'rejected' && effective >= 2) {
    db.prepare(`
      UPDATE trust_ledger SET level = 1, last_change_at = ?, last_change_by = 'auto-demote'
      WHERE agent = ? AND brand_id = ? AND action_type = ?
    `).run(nowIso, k.agent, k.brand_id, k.action_type);
    return { demoted: true };
  }
  return { demoted: false };
}

/**
 * Set a ledger row's level. `agent` and/or `action_type` may be `*` (a wildcard
 * row; see getTrustLevel). A `*` action_type may be raised above 1: pinned types
 * are held at 1 by the resolver, not by refusing the wildcard.
 */
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

/** Every ledger row owned by `agent`, for the /spine/trust route. */
export function listTrustRowsForAgent(db: Database.Database, agent: string): TrustRow[] {
  return db.prepare(
    'SELECT * FROM trust_ledger WHERE agent = ? ORDER BY brand_id, action_type',
  ).all(agent) as TrustRow[];
}
