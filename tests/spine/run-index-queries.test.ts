import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import { upsertRun, listFailedRunsSince, getRun, latestRunStartedAt } from '../../src/db/run-index-queries.js';

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
    expect(upsertRun(db, { run_id: 'r1', agent: 'finance', brand_id: 'b', skill_commit: 'a', model: 'm', started_at: '2026-09-07T06:00:00.000Z', finished_at: null, outcome: 'running', notes: '' })).toBe(true);
    expect(upsertRun(db, { run_id: 'r1', agent: 'marketing-manager', brand_id: 'b', skill_commit: 'a', model: 'm', started_at: '2026-09-07T06:00:00.000Z', finished_at: null, outcome: 'ok', notes: '' })).toBe(false);
    expect(getRun(db, 'r1')!.agent).toBe('finance');
    expect(getRun(db, 'r1')!.outcome).toBe('running');
  });
});

describe('latestRunStartedAt', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); initializeSchema(db); });
  afterEach(() => db.close());

  it('returns the newest started_at for that agent and brand', () => {
    upsertRun(db, { run_id: 'a', agent: 'finance', brand_id: 'dearborn-denim', skill_commit: 'c', model: 'm', started_at: '2026-09-08T06:00:00.000Z', finished_at: null, outcome: 'ok', notes: '' });
    upsertRun(db, { run_id: 'b', agent: 'finance', brand_id: 'dearborn-denim', skill_commit: 'c', model: 'm', started_at: '2026-09-10T06:00:00.000Z', finished_at: null, outcome: 'ok', notes: '' });
    upsertRun(db, { run_id: 'c', agent: 'sourcing', brand_id: 'dearborn-denim', skill_commit: 'c', model: 'm', started_at: '2026-09-11T06:00:00.000Z', finished_at: null, outcome: 'ok', notes: '' });
    expect(latestRunStartedAt(db, 'finance', 'dearborn-denim')).toBe('2026-09-10T06:00:00.000Z');
  });

  it('counts a run that is still running, not only a finished one', () => {
    upsertRun(db, { run_id: 'a', agent: 'finance', brand_id: 'dearborn-denim', skill_commit: 'c', model: 'm', started_at: '2026-09-11T06:00:00.000Z', finished_at: null, outcome: 'running', notes: '' });
    expect(latestRunStartedAt(db, 'finance', 'dearborn-denim')).toBe('2026-09-11T06:00:00.000Z');
  });

  it('returns null when the agent has never run', () => {
    expect(latestRunStartedAt(db, 'nobody', 'dearborn-denim')).toBeNull();
  });

  it('ignores another brand', () => {
    upsertRun(db, { run_id: 'a', agent: 'finance', brand_id: 'other-brand', skill_commit: 'c', model: 'm', started_at: '2026-09-10T06:00:00.000Z', finished_at: null, outcome: 'ok', notes: '' });
    expect(latestRunStartedAt(db, 'finance', 'dearborn-denim')).toBeNull();
  });
});
