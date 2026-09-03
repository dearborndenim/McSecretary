import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import { upsertRun, listFailedRunsSince, getRun } from '../../src/db/run-index-queries.js';

describe('run index', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); initializeSchema(db); });
  afterEach(() => db.close());

  it('upserts on run_id and lists failures since a date', () => {
    upsertRun(db, { run_id: 'r1', agent: 'finance', brand_id: 'b', skill_commit: 'abc', model: 'fable', started_at: '2026-09-07T06:00:00.000Z', finished_at: null, outcome: 'running', notes: '' });
    upsertRun(db, { run_id: 'r1', agent: 'finance', brand_id: 'b', skill_commit: 'abc', model: 'fable', started_at: '2026-09-07T06:00:00.000Z', finished_at: '2026-09-07T06:03:00.000Z', outcome: 'contract_violation', notes: 'policy file missing hurdle' });
    upsertRun(db, { run_id: 'r2', agent: 'finance', brand_id: 'b', skill_commit: 'abc', model: 'fable', started_at: '2026-09-07T06:00:00.000Z', finished_at: '2026-09-07T06:01:00.000Z', outcome: 'ok', notes: '' });
    expect(getRun(db, 'r1')!.outcome).toBe('contract_violation');
    const failed = listFailedRunsSince(db, '2026-09-07T00:00:00.000Z');
    expect(failed.map((r) => r.run_id)).toEqual(['r1']);
  });

  it('an upsert cannot change the owning agent', () => {
    upsertRun(db, { run_id: 'r1', agent: 'finance', brand_id: 'b', skill_commit: 'a', model: 'm', started_at: '2026-09-07T06:00:00.000Z', finished_at: null, outcome: 'running', notes: '' });
    upsertRun(db, { run_id: 'r1', agent: 'marketing-manager', brand_id: 'b', skill_commit: 'a', model: 'm', started_at: '2026-09-07T06:00:00.000Z', finished_at: null, outcome: 'ok', notes: '' });
    expect(getRun(db, 'r1')!.agent).toBe('finance');
  });
});
