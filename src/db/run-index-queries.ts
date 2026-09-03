import type Database from 'better-sqlite3';
import type { RunIndexInput } from '../spine/types.js';

/**
 * Upsert on run_id. The owning agent and brand are fixed by the first write;
 * returns false (no-op) when the run_id belongs to another agent.
 */
export function upsertRun(db: Database.Database, r: RunIndexInput): boolean {
  const result = db.prepare(`
    INSERT INTO agent_run_index (run_id, agent, brand_id, skill_commit, model, started_at, finished_at, outcome, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET
      finished_at = excluded.finished_at, outcome = excluded.outcome, notes = excluded.notes,
      skill_commit = excluded.skill_commit, model = excluded.model
    WHERE agent_run_index.agent = excluded.agent
  `).run(r.run_id, r.agent, r.brand_id, r.skill_commit, r.model, r.started_at, r.finished_at, r.outcome, r.notes);
  return result.changes === 1;
}

export function getRun(db: Database.Database, runId: string): RunIndexInput | undefined {
  return db.prepare('SELECT * FROM agent_run_index WHERE run_id = ?').get(runId) as RunIndexInput | undefined;
}

export function listFailedRunsSince(db: Database.Database, sinceIso: string): RunIndexInput[] {
  return db.prepare(`
    SELECT * FROM agent_run_index
    WHERE started_at >= ? AND outcome IN ('contract_violation', 'hand_error')
    ORDER BY started_at ASC, run_id ASC
  `).all(sinceIso) as RunIndexInput[];
}
