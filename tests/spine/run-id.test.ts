import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import { insertProposal, getProposalById } from '../../src/db/proposal-queries.js';

const NOW = '2026-09-07T12:00:00.000Z';
const base = {
  agent: 'a', brand_id: 'dearborn-denim', action_type: 'noop',
  action_payload: { hand: 'content-engine', method: 'POST' as const, path: '/x', body: {} },
  reason: 'r', evidence: {}, cost_usd: 0, reversible: true, level_required: 1 as const, expires_at: '2026-09-09T00:00:00.000Z',
};

describe('proposal run_id', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); initializeSchema(db); });
  afterEach(() => db.close());

  it('stores run_id when given and null otherwise', () => {
    const a = insertProposal(db, { ...base, run_id: 'run-1' }, NOW).id;
    const b = insertProposal(db, { ...base, action_type: 'other' }, NOW).id;
    expect(getProposalById(db, a)!.run_id).toBe('run-1');
    expect(getProposalById(db, b)!.run_id).toBeNull();
  });

  it('adds the column to a pre-existing proposals table without run_id', () => {
    const old = new Database(':memory:');
    old.exec(`CREATE TABLE proposals (id INTEGER PRIMARY KEY, agent TEXT, brand_id TEXT, action_type TEXT, action_payload TEXT, payload_hash TEXT, reason TEXT, evidence TEXT, cost_usd REAL, reversible INTEGER, level_required INTEGER, status TEXT, created_at TEXT, expires_at TEXT, decided_by TEXT, decided_at TEXT, edits TEXT, edit_requested_at TEXT, execution_result TEXT, telegram_chat_id TEXT, telegram_message_id INTEGER)`);
    expect(() => initializeSchema(old)).not.toThrow();
    const cols = (old.prepare('PRAGMA table_info(proposals)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('run_id');
    // Re-running the migration is a no-op.
    expect(() => initializeSchema(old)).not.toThrow();
    old.close();
  });
});
