import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import {
  getTrustLevel, recordTrustDecision, promoteTrust, demoteTrust, getTrustRow, trustSummarySince,
} from '../../src/db/trust-queries.js';

const K = { agent: 'marketing-manager', brand_id: 'dearborn-denim', action_type: 'creative_request' };
const NOW = '2026-09-07T12:00:00.000Z';

describe('trust ledger', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); initializeSchema(db); });
  afterEach(() => db.close());

  it('defaults to level 1 with no row', () => {
    expect(getTrustLevel(db, K)).toBe(1);
    expect(getTrustRow(db, K)).toBeUndefined();
  });

  it('records decisions and creates the row on first write', () => {
    recordTrustDecision(db, K, 'approved', NOW);
    recordTrustDecision(db, K, 'approved_with_edit', NOW);
    recordTrustDecision(db, K, 'rejected', NOW);
    const row = getTrustRow(db, K)!;
    expect(row.level).toBe(1);
    expect(row.approved_as_proposed).toBe(1);
    expect(row.approved_with_edit).toBe(1);
    expect(row.rejected).toBe(1);
  });

  it('promotes routine actions and refuses pinned ones', () => {
    expect(promoteTrust(db, K, 2, 'robert', NOW)).toEqual({ ok: true, level: 2 });
    expect(getTrustLevel(db, K)).toBe(2);
    const pinned = { ...K, action_type: 'ad_launch' };
    expect(promoteTrust(db, pinned, 2, 'robert', NOW)).toEqual({ ok: false, reason: 'pinned', level: 1 });
    expect(getTrustLevel(db, pinned)).toBe(1);
  });

  it('refuses promotion above 3 or below 0', () => {
    expect(promoteTrust(db, K, 4 as never, 'robert', NOW).ok).toBe(false);
    expect(promoteTrust(db, K, -1 as never, 'robert', NOW).ok).toBe(false);
  });

  it('a rejection at level 2 or 3 demotes to 1 automatically', () => {
    promoteTrust(db, K, 3, 'robert', NOW);
    const r = recordTrustDecision(db, K, 'rejected', NOW);
    expect(r.demoted).toBe(true);
    expect(getTrustLevel(db, K)).toBe(1);
    expect(getTrustRow(db, K)!.last_change_by).toBe('auto-demote');
  });

  it('a rejection at level 1 does not change level', () => {
    const r = recordTrustDecision(db, K, 'rejected', NOW);
    expect(r.demoted).toBe(false);
    expect(getTrustLevel(db, K)).toBe(1);
  });

  it('explicit demote sets level 1', () => {
    promoteTrust(db, K, 2, 'robert', NOW);
    demoteTrust(db, K, 'robert', NOW);
    expect(getTrustLevel(db, K)).toBe(1);
  });

  it('summary lists rows changed or decided since a date', () => {
    recordTrustDecision(db, K, 'approved', NOW);
    recordTrustDecision(db, { ...K, action_type: 'noop' }, 'approved', '2026-08-01T00:00:00.000Z');
    const rows = trustSummarySince(db, '2026-09-01T00:00:00.000Z');
    expect(rows.map((r) => r.action_type)).toEqual(['creative_request']);
  });
});
