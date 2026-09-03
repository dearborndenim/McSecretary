import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import { insertProposal, getProposalById } from '../../src/db/proposal-queries.js';
import { executeProposal, type ExecutorDeps } from '../../src/spine/executor.js';
import type { BrandConfig } from '../../src/spine/brand-config.js';

const NOW = '2026-09-07T12:00:00.000Z';
const brand: BrandConfig = {
  brand_id: 'dearborn-denim', display_name: 'DD', inbox_user_id: 'robert-mcmillan',
  shopify_store: 's', meta_ad_account: 'm', silent_budget_usd: 500, exploration_share: 0.2,
  proposal_expiry_hours: 48,
  hands: { 'ad-manager': { url_env: 'AM_URL', key_env: 'AM_KEY' } },
};

function deps(fetchImpl: ExecutorDeps['fetch']): ExecutorDeps {
  return { fetch: fetchImpl, env: { AM_URL: 'https://am.example/', AM_KEY: 'secret' }, loadBrand: () => brand, now: () => NOW };
}

describe('executeProposal', () => {
  let db: Database.Database;
  let id: number;
  beforeEach(() => {
    db = new Database(':memory:'); initializeSchema(db);
    id = insertProposal(db, {
      agent: 'marketing-manager', brand_id: 'dearborn-denim', action_type: 'creative_request',
      action_payload: { hand: 'ad-manager', method: 'POST', path: '/api/x', body: { n: 1 } },
      reason: 'r', evidence: {}, cost_usd: 0, reversible: true, level_required: 1, expires_at: '2026-09-09T00:00:00.000Z',
    }, NOW).id;
  });
  afterEach(() => db.close());

  it('POSTs the body to url+path with the hand bearer and marks executed', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, id: 7 }), { status: 200 }));
    const r = await executeProposal(db, id, deps(fetchMock));
    expect(r).toEqual({ ok: true, http_status: 200, body: { ok: true, id: 7 } });
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('https://am.example/api/x');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer secret');
    expect(JSON.parse(init.body as string)).toEqual({ n: 1 });
    expect(getProposalById(db, id)!.status).toBe('executed');
  });

  it('marks failed on non-2xx and stores the body', async () => {
    const r = await executeProposal(db, id, deps(async () => new Response('nope', { status: 500 })));
    expect(r.ok).toBe(false);
    const row = getProposalById(db, id)!;
    expect(row.status).toBe('failed');
    expect(JSON.parse(row.execution_result!).http_status).toBe(500);
  });

  it('marks failed when fetch throws and never rethrows', async () => {
    const r = await executeProposal(db, id, deps(async () => { throw new Error('ECONNREFUSED'); }));
    expect(r.ok).toBe(false);
    expect(getProposalById(db, id)!.status).toBe('failed');
    expect(JSON.parse(getProposalById(db, id)!.execution_result!).error).toMatch(/ECONNREFUSED/);
  });

  it('marks failed when the hand is unknown, without calling fetch', async () => {
    const fetchMock = vi.fn();
    const bad = insertProposal(db, {
      agent: 'a', brand_id: 'dearborn-denim', action_type: 'noop',
      action_payload: { hand: 'nope', method: 'POST', path: '/', body: {} },
      reason: 'r', evidence: {}, cost_usd: 0, reversible: true, level_required: 1, expires_at: '2026-09-09T00:00:00.000Z',
    }, NOW).id;
    const r = await executeProposal(db, bad, deps(fetchMock));
    expect(r.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses to execute a proposal that is not pending/approved', async () => {
    const fetchMock = vi.fn();
    await executeProposal(db, id, deps(async () => new Response('{}', { status: 200 })));
    const r = await executeProposal(db, id, deps(fetchMock)); // already executed
    expect(r.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
