import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import { insertOutcome, getFinalOutcomes, maturityLagDays } from '../../src/db/outcome-queries.js';

describe('outcome ledger', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); initializeSchema(db); });
  afterEach(() => db.close());

  it('matured_at = observed_at + the longest lag among the metrics present', () => {
    const id = insertOutcome(db, {
      artifact_id: 'cr-1', brand_id: 'dearborn-denim', lane: 'marketing',
      attributes: { angle: 'fit', hook: 'h1' }, prediction: { roas: 2.8 },
      metrics: { roas: 3.1, new_customer_return_rate: 0.19 }, observed_at: '2026-09-07T00:00:00.000Z',
    });
    const row = db.prepare('SELECT matured_at FROM outcomes WHERE id = ?').get(id) as { matured_at: string };
    expect(row.matured_at).toBe('2026-12-06T00:00:00.000Z'); // +90d
  });

  it('an unknown metric gets lag 0 and is final immediately', () => {
    expect(maturityLagDays(db, 'ops', 'made_up')).toBe(0);
    insertOutcome(db, { artifact_id: 'x', brand_id: 'b', lane: 'ops', attributes: {}, prediction: null, metrics: { made_up: 1 }, observed_at: '2026-09-07T00:00:00.000Z' });
    expect(getFinalOutcomes(db, 'ops', '2026-09-07T00:00:00.000Z')).toHaveLength(1);
  });

  it('getFinalOutcomes excludes rows before maturity', () => {
    insertOutcome(db, { artifact_id: 'cr-1', brand_id: 'b', lane: 'marketing', attributes: {}, prediction: null, metrics: { roas: 3 }, observed_at: '2026-09-07T00:00:00.000Z' });
    expect(getFinalOutcomes(db, 'marketing', '2026-09-10T00:00:00.000Z')).toHaveLength(0);
    expect(getFinalOutcomes(db, 'marketing', '2026-09-14T00:00:00.000Z')).toHaveLength(1);
  });

  it('rejects an outcome with no attributes (untagged artifact is a contract violation)', () => {
    expect(() => insertOutcome(db, { artifact_id: 'x', brand_id: 'b', lane: 'product', attributes: {}, prediction: null, metrics: { sell_through: 0.5 }, observed_at: '2026-09-07T00:00:00.000Z' }, { requireAttributes: true })).toThrow(/attributes/);
  });

  it('rejects an invalid observed_at', () => {
    expect(() => insertOutcome(db, { artifact_id: 'x', brand_id: 'b', lane: 'product', attributes: { a: 1 }, prediction: null, metrics: { sell_through: 0.5 }, observed_at: 'yesterday' })).toThrow(/observed_at/);
  });
});
