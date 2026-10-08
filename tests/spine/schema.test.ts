import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';

function tables(db: Database.Database): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[])
    .map((r) => r.name);
}

describe('spine schema', () => {
  it('creates the seven spine tables via initializeSchema', () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const t = tables(db);
    for (const name of ['proposals', 'spine_events', 'trust_ledger', 'outcomes', 'outcome_maturity', 'agent_run_index', 'rfq_messages']) {
      expect(t, name).toContain(name);
    }
  });

  it('creates rfq_replies for cross-scan RFQ intake idempotency', () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const t = tables(db);
    expect(t).toContain('rfq_replies');
    const cols = (db.prepare('PRAGMA table_info(rfq_replies)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(['message_id', 'rfq_id', 'processed_at']);
  });

  it('gives rfq_messages the columns reply correlation needs', () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const cols = (db.prepare('PRAGMA table_info(rfq_messages)').all() as { name: string }[]).map((c) => c.name);
    for (const name of [
      'rfq_id', 'vendor_email', 'vendor_domain', 'subject', 'graph_message_id', 'sent_at', 'proposal_id',
      'brand_id', 'intents', 'vendor_slug', 'vendor_name',
    ]) {
      expect(cols, name).toContain(name);
    }
  });

  it('adds spine_events.posted_by to an existing table without touching its rows', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE spine_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source_hand TEXT NOT NULL, brand_id TEXT NOT NULL,
      event_type TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', urgent INTEGER NOT NULL DEFAULT 0,
      received_at TEXT NOT NULL DEFAULT (datetime('now')), drained_by TEXT, drained_at TEXT
    )`);
    db.prepare("INSERT INTO spine_events (source_hand, brand_id, event_type, payload, urgent, received_at) VALUES ('h', 'dearborn-denim', 'po_received', '{\"po\":9}', 1, '2026-09-07T12:00:00.000Z')").run();
    const before = db.prepare('SELECT * FROM spine_events').all();
    initializeSchema(db);
    const after = db.prepare('SELECT * FROM spine_events').all();
    expect(after).toEqual([{ ...(before[0] as object), posted_by: null }]);
    initializeSchema(db);
    expect(db.prepare('SELECT * FROM spine_events').all()).toEqual(after);
    const cols = (db.prepare('PRAGMA table_info(spine_events)').all() as { name: string }[]).map((c) => c.name);
    expect(cols.filter((c) => c === 'posted_by')).toHaveLength(1);
  });

  it('adds agent_run_index.cost_usd to an existing table without touching its rows', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE agent_run_index (
      run_id TEXT PRIMARY KEY, agent TEXT NOT NULL, brand_id TEXT NOT NULL, skill_commit TEXT NOT NULL,
      model TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, outcome TEXT NOT NULL, notes TEXT NOT NULL DEFAULT ''
    )`);
    db.prepare("INSERT INTO agent_run_index (run_id, agent, brand_id, skill_commit, model, started_at, finished_at, outcome, notes) VALUES ('r1', 'sourcing', 'dearborn-denim', 'abc', 'claude-opus-5-5', '2026-09-20T06:00:00.000Z', '2026-09-20T06:09:00.000Z', 'ok', 'filed 3 RFQs')").run();
    const before = db.prepare('SELECT * FROM agent_run_index').all();
    initializeSchema(db);
    const after = db.prepare('SELECT * FROM agent_run_index').all();
    expect(after).toEqual([{ ...(before[0] as object), cost_usd: null }]);
    initializeSchema(db);
    expect(db.prepare('SELECT * FROM agent_run_index').all()).toEqual(after);
    const cols = (db.prepare('PRAGMA table_info(agent_run_index)').all() as { name: string }[]).map((c) => c.name);
    expect(cols.filter((c) => c === 'cost_usd')).toHaveLength(1);
  });

  it('is idempotent', () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    expect(() => initializeSchema(db)).not.toThrow();
  });

  it('seeds the maturity lags from the spec', () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    const rows = db.prepare('SELECT lane, metric, lag_days FROM outcome_maturity ORDER BY lane, metric').all() as
      { lane: string; metric: string; lag_days: number }[];
    expect(rows).toEqual([
      { lane: 'marketing', metric: 'new_customer_return_rate', lag_days: 90 },
      { lane: 'marketing', metric: 'roas', lag_days: 7 },
      { lane: 'ops', metric: 'on_time_delivery', lag_days: 0 },
      { lane: 'ops', metric: 'receipt_vs_promised_days', lag_days: 0 },
      { lane: 'product', metric: 'margin', lag_days: 90 },
      { lane: 'product', metric: 'repeat_purchase_rate', lag_days: 180 },
      { lane: 'product', metric: 'return_rate', lag_days: 90 },
      { lane: 'product', metric: 'sell_through', lag_days: 60 },
    ]);
  });

  it('re-seeding does not duplicate maturity rows', () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    initializeSchema(db);
    const n = (db.prepare('SELECT COUNT(*) AS n FROM outcome_maturity').get() as { n: number }).n;
    expect(n).toBe(8);
  });
});
