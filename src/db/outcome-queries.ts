import type Database from 'better-sqlite3';
import type { OutcomeInput, OutcomeRow } from '../spine/types.js';

export function maturityLagDays(db: Database.Database, lane: string, metric: string): number {
  const row = db.prepare('SELECT lag_days FROM outcome_maturity WHERE lane = ? AND metric = ?').get(lane, metric) as
    { lag_days: number } | undefined;
  return row?.lag_days ?? 0;
}

/**
 * Insert an outcome. matured_at is observed_at plus the longest lag among the
 * metrics present, so one row is final only when all its metrics are.
 */
export function insertOutcome(
  db: Database.Database,
  o: OutcomeInput,
  opts: { requireAttributes?: boolean } = {},
): number {
  if (opts.requireAttributes && Object.keys(o.attributes).length === 0) {
    throw new Error(`Outcome for ${o.artifact_id} has no attributes — untagged artifacts are a contract violation`);
  }
  const observedMs = Date.parse(o.observed_at);
  if (Number.isNaN(observedMs)) throw new Error(`Invalid observed_at: ${o.observed_at}`);
  const lag = Math.max(0, ...Object.keys(o.metrics).map((m) => maturityLagDays(db, o.lane, m)));
  const observedAt = new Date(observedMs).toISOString();
  const matured_at = new Date(observedMs + lag * 86_400_000).toISOString();
  const r = db.prepare(`
    INSERT INTO outcomes (artifact_id, brand_id, lane, attributes, prediction, metrics, observed_at, matured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    o.artifact_id, o.brand_id, o.lane, JSON.stringify(o.attributes),
    o.prediction ? JSON.stringify(o.prediction) : null, JSON.stringify(o.metrics), observedAt, matured_at,
  );
  return Number(r.lastInsertRowid);
}

/** Rows a learner may read: matured_at <= now. */
export function getFinalOutcomes(db: Database.Database, lane: string, nowIso: string): OutcomeRow[] {
  return db.prepare(
    'SELECT * FROM outcomes WHERE lane = ? AND matured_at <= ? ORDER BY observed_at ASC, id ASC',
  ).all(lane, nowIso) as OutcomeRow[];
}
