import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import { insertProposal, getProposalById } from '../../src/db/proposal-queries.js';
import { executeProposal, resolveHandUrl, type ExecutorDeps } from '../../src/spine/executor.js';
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
    expect(r).toEqual({ ok: true, http_status: 200, body: { ok: true, id: 7 }, recorded: true });
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('https://am.example/api/x');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer secret');
    expect(JSON.parse(init.body as string)).toEqual({ n: 1 });
    const row = getProposalById(db, id)!;
    expect(row.status).toBe('executed');
    expect(row.execution_result).not.toContain('secret');
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

  describe('refuses payloads that would leave the hand', () => {
    function insertWith(over: Partial<{ path: string; method: string; body: unknown }>): number {
      return insertProposal(db, {
        agent: 'a', brand_id: 'dearborn-denim', action_type: 'noop',
        action_payload: {
          hand: 'ad-manager', method: 'POST', path: '/ok', body: {},
          ...over,
        } as unknown as Parameters<typeof insertProposal>[1]['action_payload'],
        reason: 'r', evidence: {}, cost_usd: 0, reversible: true, level_required: 1, expires_at: '2026-09-09T00:00:00.000Z',
      }, NOW).id;
    }

    async function expectRefused(pid: number, pattern: RegExp): Promise<void> {
      const fetchMock = vi.fn();
      const r = await executeProposal(db, pid, deps(fetchMock));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(pattern);
      expect(fetchMock).not.toHaveBeenCalled();
      const row = getProposalById(db, pid)!;
      expect(row.status).toBe('failed');
      expect(JSON.parse(row.execution_result!).error).toMatch(pattern);
      expect(row.execution_result).not.toContain('secret');
    }

    it.each([
      ['@evil.com/x', /Invalid path/],
      ['.evil.com/x', /Invalid path/],
      [':8443/x', /Invalid path/],
      ['//evil.com/x', /Invalid path/],
      ['/x?y=1', /Invalid path/],
      ['/x#frag', /Invalid path/],
      ['/x y', /Invalid path/],
      ['/\\evil.com/x', /Invalid path|escapes hand origin/],
      ['x', /Invalid path/],
    ])('path %s', async (path, pattern) => {
      await expectRefused(insertWith({ path }), pattern);
    });

    it('method GET', async () => {
      await expectRefused(insertWith({ method: 'GET' }), /Invalid method: GET/);
    });

    it('body array', async () => {
      await expectRefused(insertWith({ body: [1, 2] }), /Invalid body/);
    });

    it('body null', async () => {
      await expectRefused(insertWith({ body: null }), /Invalid body/);
    });
  });

  it('joins base path and hand path; trailing slash on base is fine', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    const pid = insertProposal(db, {
      agent: 'a', brand_id: 'dearborn-denim', action_type: 'spend',
      action_payload: { hand: 'ad-manager', method: 'POST', path: '/spend', body: {} },
      reason: 'r', evidence: {}, cost_usd: 0, reversible: true, level_required: 1, expires_at: '2026-09-09T00:00:00.000Z',
    }, NOW).id;
    const d = deps(fetchMock);
    d.env = { AM_URL: 'https://am.example/api/', AM_KEY: 'secret' };
    const r = await executeProposal(db, pid, d);
    expect(r.ok).toBe(true);
    expect(fetchMock.mock.calls[0]![0]).toBe('https://am.example/api/spend');
  });

  it('caps the stored response body at 16 KB but returns the full body', async () => {
    const big = 'x'.repeat(20000);
    const r = await executeProposal(db, id, deps(async () => new Response(big, { status: 200 })));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.body).toBe(big);
    const stored = JSON.parse(getProposalById(db, id)!.execution_result!) as { body: string };
    expect(stored.body.length).toBeLessThan(big.length);
    expect(stored.body.endsWith('…[truncated]')).toBe(true);
  });

  it('reports recorded=false when the row was decided between read and write', async () => {
    const fetchImpl = async () => {
      // Simulate a concurrent rejection while the hand call is in flight.
      db.prepare("UPDATE proposals SET status = 'rejected' WHERE id = ?").run(id);
      return new Response('{}', { status: 200 });
    };
    const r = await executeProposal(db, id, deps(fetchImpl));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.recorded).toBe(false);
    expect(getProposalById(db, id)!.status).toBe('rejected');
  });
});

describe('resolveHandUrl', () => {
  it('stays under the base path and origin', () => {
    expect(resolveHandUrl('https://am.example', '/x')).toEqual({ ok: true, href: 'https://am.example/x' });
    expect(resolveHandUrl('https://am.example/api', '/x/y')).toEqual({ ok: true, href: 'https://am.example/api/x/y' });
    expect(resolveHandUrl('https://am.example/api/', '/x')).toEqual({ ok: true, href: 'https://am.example/api/x' });
  });

  it('refuses dot-segments that climb above the base path', () => {
    expect(resolveHandUrl('https://am.example/api', '/../admin').ok).toBe(false);
    expect(resolveHandUrl('https://am.example/api', '/x/../../admin').ok).toBe(false);
    expect(resolveHandUrl('https://am.example/api', '/x/../y')).toEqual({ ok: true, href: 'https://am.example/api/y' });
  });

  it('refuses a sibling-prefix escape and whitespace', () => {
    expect(resolveHandUrl('https://am.example/a/b', '/../bx').ok).toBe(false);
    expect(resolveHandUrl('https://am.example/a/b', '/x y').ok).toBe(false);
  });

  it('refuses percent-encoded slash and dot so an upstream that decodes them cannot be walked', () => {
    expect(resolveHandUrl('https://am.example/api', '/x%2Fy')).toEqual({ ok: false, error: 'Invalid path: percent-encoded slash or dot' });
    expect(resolveHandUrl('https://am.example/api', '/%2e%2e/admin')).toEqual({ ok: false, error: 'Invalid path: percent-encoded slash or dot' });
    expect(resolveHandUrl('https://am.example/api', '/x%20y')).toEqual({ ok: true, href: 'https://am.example/api/x%20y' });
  });

  it('refuses a malformed base URL', () => {
    expect(resolveHandUrl('not a url', '/x').ok).toBe(false);
  });
});
