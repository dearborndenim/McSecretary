import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import {
  insertProposal, getProposalById, listPendingProposals, decideProposal,
  recordExecution, expireProposals, setTelegramRef, appendEdit, setEditRequested,
  findEditRequestedForChat, updateActionPayload, listProposalsByAgent,
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

  it('normalises expires_at to ISO UTC and rejects garbage', () => {
    const { id } = insertProposal(db, input({ expires_at: '2026-09-09T14:00:00+02:00' }), NOW);
    expect(getProposalById(db, id)!.expires_at).toBe('2026-09-09T12:00:00.000Z');
    expect(() => insertProposal(db, input({ expires_at: 'next tuesday' }), NOW)).toThrow(/Invalid expires_at/);
  });

  it('an approved or executed row still de-duplicates until it expires', () => {
    const a = insertProposal(db, input(), NOW);
    decideProposal(db, a.id, 'approved', 'robert', NOW);
    expect(insertProposal(db, input(), NOW)).toEqual({ id: a.id, deduped: true });
    recordExecution(db, a.id, 'executed', {});
    expect(insertProposal(db, input(), NOW)).toEqual({ id: a.id, deduped: true });
  });

  it('decide, setEditRequested and recordExecution are no-ops on ineligible rows', () => {
    const { id } = insertProposal(db, input(), NOW);
    expect(decideProposal(db, id, 'rejected', 'robert', NOW)).toBe(true);
    expect(decideProposal(db, id, 'approved', 'robert', NOW)).toBe(false);
    expect(setEditRequested(db, id, NOW)).toBe(false);
    expect(recordExecution(db, id, 'executed', {})).toBe(false);
    expect(getProposalById(db, id)!.status).toBe('rejected');
  });

  it('updateActionPayload replaces the stored payload', () => {
    const { id } = insertProposal(db, input(), NOW);
    updateActionPayload(db, id, { hand: 'content-engine', method: 'POST', path: '/api/briefs', body: { angle: 'x' } });
    expect(JSON.parse(getProposalById(db, id)!.action_payload).body.angle).toBe('x');
  });

  it('updateActionPayload is a no-op on a decided row', () => {
    const { id } = insertProposal(db, input(), NOW);
    decideProposal(db, id, 'rejected', 'robert', NOW);
    const before = getProposalById(db, id)!;
    expect(updateActionPayload(db, id, { hand: 'content-engine', method: 'POST', path: '/api/briefs', body: { angle: 'x' } })).toBe(false);
    const after = getProposalById(db, id)!;
    expect(after.action_payload).toBe(before.action_payload);
    expect(after.payload_hash).toBe(before.payload_hash);
  });
});

describe('listProposalsByAgent', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); initializeSchema(db); });
  afterEach(() => db.close());

  it('returns that agent + brand newest first, any status, capped at limit', () => {
    for (let i = 1; i <= 4; i++) {
      // insertProposal de-dupes on hashPayload(action_payload) alone, NOT on
      // reason — so the BODY has to differ per row or rows 2-4 collapse into row 1.
      insertProposal(db, input({
        agent: 'finance', reason: `r${i}`,
        action_payload: { hand: 'notes', method: 'POST', path: '/note', body: { title: `t${i}`, summary: 's' } },
      }), `2026-09-0${i}T00:00:00.000Z`);
    }
    insertProposal(db, input({ agent: 'sourcing', reason: 'other' }), '2026-09-09T00:00:00.000Z');
    const rows = listProposalsByAgent(db, 'finance', 'dearborn-denim', 3);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.reason)).toEqual(['r4', 'r3', 'r2']);
    expect(rows.every((r) => r.agent === 'finance')).toBe(true);
  });

  it('includes decided and executed rows, not just pending ones', () => {
    const { id } = insertProposal(db, input({ agent: 'finance' }), NOW);
    decideProposal(db, id, 'rejected', 'robert', NOW);
    const rows = listProposalsByAgent(db, 'finance', 'dearborn-denim', 5);
    expect(rows.map((r) => r.status)).toEqual(['rejected']);
  });

  it('excludes another brand', () => {
    insertProposal(db, input({ agent: 'finance', brand_id: 'other-brand' }), NOW);
    expect(listProposalsByAgent(db, 'finance', 'dearborn-denim', 5)).toHaveLength(0);
  });

  it('returns an empty array for an agent that has never filed', () => {
    expect(listProposalsByAgent(db, 'nobody', 'dearborn-denim', 5)).toEqual([]);
  });
});
