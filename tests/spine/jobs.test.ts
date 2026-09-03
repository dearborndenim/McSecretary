import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import { insertProposal } from '../../src/db/proposal-queries.js';
import { insertEvent } from '../../src/db/event-queries.js';
import { upsertRun } from '../../src/db/run-index-queries.js';
import { recordTrustDecision, promoteTrust } from '../../src/db/trust-queries.js';
import { runExpirySweep, buildTrustMonthlySummary } from '../../src/spine/jobs.js';

const NOW = '2026-09-08T10:00:00.000Z';

describe('spine jobs', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); initializeSchema(db); });
  afterEach(() => db.close());

  it('expiry sweep expires, lists stale events and failed runs, and returns a report or null', () => {
    expect(runExpirySweep(db, NOW)).toBeNull(); // nothing to say
    insertProposal(db, { agent: 'a', brand_id: 'b', action_type: 'noop', action_payload: { hand: 'h', method: 'POST', path: '/', body: {} }, reason: 'r', evidence: {}, cost_usd: 0, reversible: true, level_required: 1, expires_at: '2026-09-08T00:00:00.000Z' }, '2026-09-06T00:00:00.000Z');
    insertEvent(db, { source_hand: 'h', brand_id: 'b', event_type: 'old', payload: {}, urgent: false }, '2026-08-20T00:00:00.000Z');
    upsertRun(db, { run_id: 'r1', agent: 'finance', brand_id: 'b', skill_commit: 'c', model: 'm', started_at: '2026-09-08T06:00:00.000Z', finished_at: '2026-09-08T06:01:00.000Z', outcome: 'hand_error', notes: 'quickbooks 500' });
    const report = runExpirySweep(db, NOW)!;
    expect(report).toContain('Expired 1 proposal');
    expect(report).toContain('a noop');
    expect(report).toContain('1 event undrained > 7d');
    expect(report).toContain('finance r1 hand_error');
    expect(runExpirySweep(db, NOW)).toContain('1 event undrained'); // events still stale, proposal no longer listed
  });

  it('expiry sweep caps each list at 10 and says how many more', () => {
    for (let i = 0; i < 12; i++) {
      insertProposal(db, { agent: 'a', brand_id: 'b', action_type: 'noop', action_payload: { hand: 'h', method: 'POST', path: `/p${i}`, body: {} }, reason: 'r', evidence: {}, cost_usd: 0, reversible: true, level_required: 1, expires_at: '2026-09-08T00:00:00.000Z' }, '2026-09-06T00:00:00.000Z');
    }
    const report = runExpirySweep(db, NOW)!;
    expect(report).toContain('Expired 12 proposals unanswered:');
    expect(report.split('\n').filter((l) => l.startsWith('  #'))).toHaveLength(10);
    expect(report).toContain('  …and 2 more');
  });

  it('monthly summary groups by agent with counts and level, or null when quiet', () => {
    expect(buildTrustMonthlySummary(db, '2026-09-01T00:00:00.000Z')).toBeNull();
    const k = { agent: 'marketing-manager', brand_id: 'b', action_type: 'creative_request' };
    recordTrustDecision(db, k, 'approved', '2026-09-05T00:00:00.000Z');
    recordTrustDecision(db, k, 'approved', '2026-09-06T00:00:00.000Z');
    recordTrustDecision(db, k, 'approved_with_edit', '2026-09-07T00:00:00.000Z');
    promoteTrust(db, { ...k, action_type: 'noop' }, 2, 'robert', '2026-09-07T00:00:00.000Z');
    const s = buildTrustMonthlySummary(db, '2026-09-01T00:00:00.000Z')!;
    expect(s).toContain('marketing-manager');
    expect(s).toContain('creative_request L1 · 2 as proposed · 1 edited · 0 rejected');
    expect(s).toContain('noop L2');
    expect(s).toContain('Reply "promote <agent> <action> <level>"');
  });
});
