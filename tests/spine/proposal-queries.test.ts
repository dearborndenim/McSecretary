import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import {
  insertProposal, getProposalById, listPendingProposals, decideProposal,
  recordExecution, expireProposals, setTelegramRef, appendEdit, setEditRequested,
  findEditRequestedForChat,
} from '../../src/db/proposal-queries.js';
import type { ProposalInput } from '../../src/spine/types.js';

const NOW = '2026-09-07T12:00:00.000Z';

function input(over: Partial<ProposalInput> = {}): ProposalInput {
  return {
    agent: 'marketing-manager',
    brand_id: 'dearborn-denim',
    action_type: 'creative_request',
    action_payload: { hand: 'content-engine', method: 'POST', path: '/api/briefs', body: { angle: 'fit' } },
    reason: 'Fit angle has the best matured hook rate.',
    evidence: { hook_rate: 0.31, matured_days: 7 },
    cost_usd: 0,
    reversible: true,
    level_required: 1,
    expires_at: '2026-09-09T12:00:00.000Z',
    ...over,
  };
}

describe('proposal queries', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); initializeSchema(db); });
  afterEach(() => db.close());

  it('inserts and reads back with JSON columns', () => {
    const { id, deduped } = insertProposal(db, input(), NOW);
    expect(deduped).toBe(false);
    const row = getProposalById(db, id)!;
    expect(row.status).toBe('pending');
    expect(JSON.parse(row.action_payload).body.angle).toBe('fit');
    expect(JSON.parse(row.evidence).hook_rate).toBe(0.31);
    expect(row.reversible).toBe(1);
    expect(row.payload_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('de-duplicates an identical live proposal and returns the existing id', () => {
    const a = insertProposal(db, input(), NOW);
    const b = insertProposal(db, input({ reason: 'different wording, same action' }), NOW);
    expect(b.id).toBe(a.id);
    expect(b.deduped).toBe(true);
    expect(listPendingProposals(db)).toHaveLength(1);
  });

  it('does not de-duplicate against an expired or rejected proposal', () => {
    const a = insertProposal(db, input({ expires_at: '2026-09-07T11:00:00.000Z' }), NOW);
    expireProposals(db, NOW);
    const b = insertProposal(db, input(), NOW);
    expect(b.id).not.toBe(a.id);
    decideProposal(db, b.id, 'rejected', 'robert', NOW);
    const c = insertProposal(db, input(), NOW);
    expect(c.id).not.toBe(b.id);
  });

  it('a different payload is a different proposal', () => {
    const a = insertProposal(db, input(), NOW);
    const b = insertProposal(db, input({ action_payload: { hand: 'content-engine', method: 'POST', path: '/api/briefs', body: { angle: 'durability' } } }), NOW);
    expect(b.id).not.toBe(a.id);
  });

  it('decide stamps who and when, and lists exclude decided rows', () => {
    const { id } = insertProposal(db, input(), NOW);
    decideProposal(db, id, 'approved', 'robert', NOW);
    const row = getProposalById(db, id)!;
    expect(row.status).toBe('approved');
    expect(row.decided_by).toBe('robert');
    expect(row.decided_at).toBe(NOW);
    expect(listPendingProposals(db)).toHaveLength(0);
  });

  it('records execution result and status', () => {
    const { id } = insertProposal(db, input(), NOW);
    recordExecution(db, id, 'executed', { http_status: 200, body: { ok: true } });
    const row = getProposalById(db, id)!;
    expect(row.status).toBe('executed');
    expect(JSON.parse(row.execution_result!).http_status).toBe(200);
  });

  it('expire only touches pending rows past expires_at and returns them', () => {
    const live = insertProposal(db, input({ expires_at: '2026-09-09T00:00:00.000Z' }), NOW).id;
    const old = insertProposal(db, input({ action_type: 'noop', expires_at: '2026-09-07T00:00:00.000Z' }), NOW).id;
    const expired = expireProposals(db, NOW);
    expect(expired.map((p) => p.id)).toEqual([old]);
    expect(getProposalById(db, live)!.status).toBe('pending');
    expect(getProposalById(db, old)!.status).toBe('expired');
  });

  it('stores telegram refs and edit flow', () => {
    const { id } = insertProposal(db, input(), NOW);
    setTelegramRef(db, id, '12345', 987);
    setEditRequested(db, id, NOW);
    expect(findEditRequestedForChat(db, '12345')!.id).toBe(id);
    appendEdit(db, id, { at: NOW, note: 'angle=durability' });
    appendEdit(db, id, { at: NOW, note: 'angle=fit' });
    const row = getProposalById(db, id)!;
    expect(row.telegram_message_id).toBe(987);
    expect(JSON.parse(row.edits!)).toHaveLength(2);
  });
});
