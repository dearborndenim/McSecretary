import type Database from 'better-sqlite3';
import type { SpineEventInput, SpineEventRow } from '../spine/types.js';

/** `postedBy` is the authenticated agent for an HTTP post; omitted (null) for in-process events. */
export function insertEvent(db: Database.Database, e: SpineEventInput, nowIso: string, postedBy?: string): number {
  const r = db.prepare(`
    INSERT INTO spine_events (source_hand, brand_id, event_type, payload, urgent, received_at, posted_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(e.source_hand, e.brand_id, e.event_type, JSON.stringify(e.payload), e.urgent ? 1 : 0, nowIso, postedBy ?? null);
  return Number(r.lastInsertRowid);
}

/** Newest event id from before per-consumer delivery (spine-schema.ts); 0 when unset. */
export function deliveryCutoverId(db: Database.Database): number {
  const r = db.prepare("SELECT value FROM spine_meta WHERE key = 'delivery_cutover_id'").get() as { value: string } | undefined;
  return r ? Number(r.value) : 0;
}

/**
 * Events still owed to `agent`. At or below the cutover: nobody has drained it
 * (the old one-drain rule). Above it: `agent` has no delivery row, and the event
 * was not consumed outside the delivery table (an in-process drain sets
 * drained_at with no delivery row, which still consumes it for everyone).
 * Binds (cutover, cutover, agent).
 */
const OWED = `((e.id <= ? AND e.drained_at IS NULL) OR (e.id > ?
  AND NOT EXISTS (SELECT 1 FROM spine_event_deliveries d WHERE d.event_id = e.id AND d.agent = ?)
  AND (e.drained_at IS NULL OR EXISTS (SELECT 1 FROM spine_event_deliveries d2 WHERE d2.event_id = e.id))))`;

/**
 * Return the events of the given types owed to `agent` and record them drained
 * by it. Each consumer gets each event once; spine_events.drained_by/at keep the
 * first drainer for readers that mean "nobody drained it yet".
 * With `brandId`, only that brand's events are taken; without it every
 * brand's (the behaviour of a kit that predates per-brand drains).
 */
export function drainEvents(
  db: Database.Database, agent: string, types: string[], nowIso: string, brandId?: string,
): SpineEventRow[] {
  if (types.length === 0) return [];
  const cutover = deliveryCutoverId(db);
  const marks = types.map(() => '?').join(',');
  const brandClause = brandId === undefined ? '' : ' AND e.brand_id = ?';
  const args: (string | number)[] = [cutover, cutover, agent, ...types, ...(brandId === undefined ? [] : [brandId])];
  const legacy = db.prepare('UPDATE spine_events SET drained_by = ?, drained_at = ? WHERE id = ? AND drained_at IS NULL');
  const deliver = db.prepare('INSERT OR IGNORE INTO spine_event_deliveries (event_id, agent, drained_at) VALUES (?, ?, ?)');
  return db.transaction(() => {
    const rows = db.prepare(
      `SELECT e.* FROM spine_events e WHERE ${OWED} AND e.event_type IN (${marks})${brandClause} ORDER BY e.id ASC`,
    ).all(...args) as SpineEventRow[];
    const claimed: SpineEventRow[] = [];
    for (const r of rows) {
      if (r.id <= cutover) {
        if (legacy.run(agent, nowIso, r.id).changes === 1) claimed.push({ ...r, drained_by: agent, drained_at: nowIso });
      } else if (deliver.run(r.id, agent, nowIso).changes === 1) {
        legacy.run(agent, nowIso, r.id);
        claimed.push({ ...r, drained_by: agent, drained_at: nowIso });
      }
    }
    return claimed;
  })();
}

export function listStaleEvents(db: Database.Database, olderThanDays: number, nowIso: string): SpineEventRow[] {
  const cutoff = new Date(new Date(nowIso).getTime() - olderThanDays * 86_400_000).toISOString();
  return db.prepare(
    'SELECT * FROM spine_events WHERE drained_at IS NULL AND received_at < ? ORDER BY received_at ASC, id ASC',
  ).all(cutoff) as SpineEventRow[];
}

/** Events `agent` posted over HTTP (posted_by) received at or after `sinceIso`. */
export function countEventsSince(db: Database.Database, agent: string, sinceIso: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM spine_events WHERE posted_by = ? AND received_at >= ?')
    .get(agent, sinceIso) as { n: number }).n;
}

export function countUndrainedUrgent(db: Database.Database, brandId: string): number {
  return (db.prepare(
    'SELECT COUNT(*) AS n FROM spine_events WHERE drained_at IS NULL AND urgent = 1 AND brand_id = ?',
  ).get(brandId) as { n: number }).n;
}

/**
 * Non-mutating counts for the runner's urgent poll; `brandId` narrows them to one brand.
 * With `agent`, counts what that agent's drain would return; without it, what nobody has drained.
 */
export function countPendingByType(
  db: Database.Database, types: string[], brandId?: string, agent?: string,
): Record<string, { pending: number; urgent: number }> {
  const brandClause = brandId === undefined ? '' : ' AND e.brand_id = ?';
  const owed = agent === undefined ? 'e.drained_at IS NULL' : OWED;
  const cutover = agent === undefined ? 0 : deliveryCutoverId(db);
  const pre: (string | number)[] = agent === undefined ? [] : [cutover, cutover, agent];
  const stmt = db.prepare(`SELECT COUNT(*) AS pending, COALESCE(SUM(e.urgent), 0) AS urgent FROM spine_events e WHERE ${owed} AND e.event_type = ?${brandClause}`);
  const out: Record<string, { pending: number; urgent: number }> = {};
  for (const t of types) {
    const r = stmt.get(...pre, t, ...(brandId === undefined ? [] : [brandId])) as { pending: number; urgent: number };
    out[t] = { pending: r.pending, urgent: r.urgent };
  }
  return out;
}
