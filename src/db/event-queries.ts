import type Database from 'better-sqlite3';
import type { SpineEventInput, SpineEventRow } from '../spine/types.js';

export function insertEvent(db: Database.Database, e: SpineEventInput, nowIso: string): number {
  const r = db.prepare(`
    INSERT INTO spine_events (source_hand, brand_id, event_type, payload, urgent, received_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(e.source_hand, e.brand_id, e.event_type, JSON.stringify(e.payload), e.urgent ? 1 : 0, nowIso);
  return Number(r.lastInsertRowid);
}

/**
 * Return undrained events of the given types and mark them drained by `agent`.
 * With `brandId`, only that brand's events are taken; without it every
 * brand's (the behaviour of a kit that predates per-brand drains).
 */
export function drainEvents(
  db: Database.Database, agent: string, types: string[], nowIso: string, brandId?: string,
): SpineEventRow[] {
  if (types.length === 0) return [];
  const marks = types.map(() => '?').join(',');
  const brandClause = brandId === undefined ? '' : ' AND brand_id = ?';
  const args: string[] = brandId === undefined ? types : [...types, brandId];
  const rows = db.prepare(
    `SELECT * FROM spine_events WHERE drained_at IS NULL AND event_type IN (${marks})${brandClause} ORDER BY id ASC`,
  ).all(...args) as SpineEventRow[];
  const stmt = db.prepare('UPDATE spine_events SET drained_by = ?, drained_at = ? WHERE id = ? AND drained_at IS NULL');
  const claimed: SpineEventRow[] = [];
  for (const r of rows) {
    if (stmt.run(agent, nowIso, r.id).changes === 1) claimed.push({ ...r, drained_by: agent, drained_at: nowIso });
  }
  return claimed;
}

export function listStaleEvents(db: Database.Database, olderThanDays: number, nowIso: string): SpineEventRow[] {
  const cutoff = new Date(new Date(nowIso).getTime() - olderThanDays * 86_400_000).toISOString();
  return db.prepare(
    'SELECT * FROM spine_events WHERE drained_at IS NULL AND received_at < ? ORDER BY received_at ASC, id ASC',
  ).all(cutoff) as SpineEventRow[];
}

export function countUndrainedUrgent(db: Database.Database, brandId: string): number {
  return (db.prepare(
    'SELECT COUNT(*) AS n FROM spine_events WHERE drained_at IS NULL AND urgent = 1 AND brand_id = ?',
  ).get(brandId) as { n: number }).n;
}

/** Non-mutating counts for the runner's urgent poll; `brandId` narrows them to one brand. */
export function countPendingByType(
  db: Database.Database, types: string[], brandId?: string,
): Record<string, { pending: number; urgent: number }> {
  const brandClause = brandId === undefined ? '' : ' AND brand_id = ?';
  const stmt = db.prepare(`SELECT COUNT(*) AS pending, COALESCE(SUM(urgent), 0) AS urgent FROM spine_events WHERE drained_at IS NULL AND event_type = ?${brandClause}`);
  const out: Record<string, { pending: number; urgent: number }> = {};
  for (const t of types) {
    const r = (brandId === undefined ? stmt.get(t) : stmt.get(t, brandId)) as { pending: number; urgent: number };
    out[t] = { pending: r.pending, urgent: r.urgent };
  }
  return out;
}
