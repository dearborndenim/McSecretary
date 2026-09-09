import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import { insertProposal, getProposalById } from '../../src/db/proposal-queries.js';
import { executeProposal, resolveHandUrl, extractNotify, type ExecutorDeps } from '../../src/spine/executor.js';
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

describe('executeProposal: built-in notes hand', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); initializeSchema(db); });
  afterEach(() => db.close());

  function insertNotes(over: Partial<{ title: string; summary: string; notify: string; details: unknown }> = {}): number {
    return insertProposal(db, {
      agent: 'ops-agent', brand_id: 'dearborn-denim', action_type: 'capacity_warning',
      action_payload: {
        hand: 'notes', method: 'POST', path: '/note',
        body: { title: 'Line 2 at capacity', summary: 'Utilization hit 92% this week.', ...over },
      },
      reason: 'r', evidence: {}, cost_usd: 0, reversible: true, level_required: 1, expires_at: '2026-09-09T00:00:00.000Z',
    }, NOW).id;
  }

  it('short-circuits: no HTTP call, records a 200 with the body as the response, returns ok', async () => {
    const fetchMock = vi.fn();
    const id = insertNotes();
    const r = await executeProposal(db, id, deps(fetchMock));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(r).toEqual({
      ok: true, http_status: 200,
      body: { title: 'Line 2 at capacity', summary: 'Utilization hit 92% this week.' },
      recorded: true,
    });
    const row = getProposalById(db, id)!;
    expect(row.status).toBe('executed');
    const stored = JSON.parse(row.execution_result!) as { http_status: number; body: unknown };
    expect(stored.http_status).toBe(200);
    expect(stored.body).toEqual({ title: 'Line 2 at capacity', summary: 'Utilization hit 92% this week.' });
  });

  it('falls through to a real HTTP call when the brand registers its own notes hand', async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    const id = insertNotes();
    const overriding: BrandConfig = { ...brand, hands: { ...brand.hands, notes: { url_env: 'NOTES_URL', key_env: 'NOTES_KEY' } } };
    const d: ExecutorDeps = { ...deps(fetchMock), loadBrand: () => overriding, env: { NOTES_URL: 'https://notes.example', NOTES_KEY: 'k' } };
    const r = await executeProposal(db, id, d);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(r.ok).toBe(true);
    expect(fetchMock.mock.calls[0]![0]).toBe('https://notes.example/note');
  });

  it('never records the hand bearer even though it short-circuits', async () => {
    const id = insertNotes({ details: { secret: 'not-a-real-secret' } });
    await executeProposal(db, id, deps(vi.fn()));
    expect(getProposalById(db, id)!.execution_result).not.toContain('AM_KEY');
  });
});

function selectEvents(db: Database.Database): { event_type: string; source_hand: string; brand_id: string; urgent: number; payload: string }[] {
  return db.prepare('SELECT * FROM spine_events ORDER BY id ASC').all() as {
    event_type: string; source_hand: string; brand_id: string; urgent: number; payload: string;
  }[];
}

describe('executeProposal: executed-event emission', () => {
  let db: Database.Database;
  let id: number;
  beforeEach(() => {
    db = new Database(':memory:'); initializeSchema(db);
    id = insertProposal(db, {
      agent: 'technical-designer', brand_id: 'dearborn-denim', action_type: 'design_sheet',
      action_payload: { hand: 'ad-manager', method: 'POST', path: '/api/x', body: { n: 1 } },
      reason: 'r', evidence: {}, cost_usd: 0, reversible: true, level_required: 1, expires_at: '2026-09-09T00:00:00.000Z',
    }, NOW).id;
  });
  afterEach(() => db.close());

  it('emits <action_type>_executed with the right type/payload/urgent on success', async () => {
    const r = await executeProposal(db, id, deps(async () => new Response(JSON.stringify({ ok: true, ref: 'abc' }), { status: 200 })));
    expect(r.ok).toBe(true);
    const events = selectEvents(db);
    expect(events).toHaveLength(1);
    expect(events[0]!.event_type).toBe('design_sheet_executed');
    expect(events[0]!.source_hand).toBe('spine');
    expect(events[0]!.brand_id).toBe('dearborn-denim');
    expect(events[0]!.urgent).toBe(1);
    expect(JSON.parse(events[0]!.payload)).toEqual({
      proposal_id: id, agent: 'technical-designer', action_type: 'design_sheet',
      hand: 'ad-manager', path: '/api/x', response: { ok: true, ref: 'abc' },
      ok: true, ref: 'abc',
    });
  });

  it('does not emit on a failed execution (non-2xx)', async () => {
    await executeProposal(db, id, deps(async () => new Response('nope', { status: 500 })));
    expect(selectEvents(db)).toHaveLength(0);
  });

  it('does not emit when fetch throws', async () => {
    await executeProposal(db, id, deps(async () => { throw new Error('boom'); }));
    expect(selectEvents(db)).toHaveLength(0);
  });

  it('does not emit when the row was decided out from under the execution (recorded=false)', async () => {
    const fetchImpl = async () => {
      db.prepare("UPDATE proposals SET status = 'rejected' WHERE id = ?").run(id);
      return new Response('{}', { status: 200 });
    };
    const r = await executeProposal(db, id, deps(fetchImpl));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.recorded).toBe(false);
    expect(selectEvents(db)).toHaveLength(0);
  });

  it('emits both sourcing_option_executed and sourcing_options_executed once each for a sourcing_option proposal', async () => {
    const sid = insertProposal(db, {
      agent: 'sourcing-agent', brand_id: 'dearborn-denim', action_type: 'sourcing_option',
      action_payload: { hand: 'ad-manager', method: 'POST', path: '/api/y', body: {} },
      reason: 'r', evidence: {}, cost_usd: 0, reversible: true, level_required: 1, expires_at: '2026-09-09T00:00:00.000Z',
    }, NOW).id;
    await executeProposal(db, sid, deps(async () => new Response('{}', { status: 200 })));
    const events = selectEvents(db);
    expect(events.map((e) => e.event_type).sort()).toEqual(['sourcing_option_executed', 'sourcing_options_executed']);
    expect(events.every((e) => e.urgent === 1)).toBe(true);
  });

  it('does not pluralize any other action type', async () => {
    await executeProposal(db, id, deps(async () => new Response('{}', { status: 200 })));
    expect(selectEvents(db).map((e) => e.event_type)).toEqual(['design_sheet_executed']);
  });

  it('truncates a large response body to 4 KB on the event payload', async () => {
    const big = JSON.stringify({ blob: 'x'.repeat(10000) });
    await executeProposal(db, id, deps(async () => new Response(big, { status: 200 })));
    const events = selectEvents(db);
    const payload = JSON.parse(events[0]!.payload) as { response: unknown };
    expect(typeof payload.response).toBe('string');
    expect((payload.response as string).length).toBeLessThan(big.length);
    expect((payload.response as string).endsWith('…[truncated]')).toBe(true);
    expect(Buffer.byteLength(payload.response as string, 'utf8')).toBeLessThan(big.length);
  });

  it('is best-effort: a DB error inserting the event never fails the execution', async () => {
    db.exec('DROP TABLE spine_events');
    const r = await executeProposal(db, id, deps(async () => new Response('{}', { status: 200 })));
    expect(r.ok).toBe(true);
    expect(getProposalById(db, id)!.status).toBe('executed');
  });
});

describe('executeProposal: flattening the hand response onto the event payload', () => {
  let db: Database.Database;
  let id: number;
  beforeEach(() => {
    db = new Database(':memory:'); initializeSchema(db);
    id = insertProposal(db, {
      agent: 'technical-designer', brand_id: 'dearborn-denim', action_type: 'design_sheet',
      action_payload: { hand: 'ad-manager', method: 'POST', path: '/api/x', body: { n: 1 } },
      reason: 'r', evidence: {}, cost_usd: 0, reversible: true, level_required: 1, expires_at: '2026-09-09T00:00:00.000Z',
    }, NOW).id;
  });
  afterEach(() => db.close());

  it('copies top-level scalar response fields onto the payload; arrays stay nested only under response', async () => {
    const responseBody = {
      slug: 'rail-capsule-2', revision: 3, brand: 'dearborn-denim',
      json_url: 'https://x.example/y.json', designsheet_urls: ['a', 'b'],
    };
    await executeProposal(db, id, deps(async () => new Response(JSON.stringify(responseBody), { status: 200 })));
    const payload = JSON.parse(selectEvents(db)[0]!.payload) as Record<string, unknown>;
    expect(payload.slug).toBe('rail-capsule-2');
    expect(payload.revision).toBe(3);
    expect(payload.brand).toBe('dearborn-denim');
    expect(payload.json_url).toBe('https://x.example/y.json');
    expect(payload).not.toHaveProperty('designsheet_urls');
    expect(payload.response).toEqual(responseBody);
  });

  it('does not let a response key named path or agent overwrite the fixed event keys', async () => {
    const responseBody = { path: '/should-not-win', agent: 'not-the-real-agent', slug: 'x' };
    await executeProposal(db, id, deps(async () => new Response(JSON.stringify(responseBody), { status: 200 })));
    const payload = JSON.parse(selectEvents(db)[0]!.payload) as Record<string, unknown>;
    expect(payload.path).toBe('/api/x');
    expect(payload.agent).toBe('technical-designer');
    expect(payload.slug).toBe('x');
    expect(payload.response).toEqual(responseBody);
  });

  it('flattens nothing when the response was byte-truncated to a string', async () => {
    const big = JSON.stringify({ slug: 'should-not-appear', blob: 'x'.repeat(10000) });
    await executeProposal(db, id, deps(async () => new Response(big, { status: 200 })));
    const payload = JSON.parse(selectEvents(db)[0]!.payload) as Record<string, unknown>;
    expect(typeof payload.response).toBe('string');
    expect(payload).not.toHaveProperty('slug');
  });

  it('falls back to action_payload.body for slug/revision/id/techpack_id when the response omits them', async () => {
    const pid = insertProposal(db, {
      agent: 'pattern-maker', brand_id: 'dearborn-denim', action_type: 'pattern_file',
      action_payload: { hand: 'ad-manager', method: 'POST', path: '/api/z', body: { techpack_id: 42, revision: 2, extra: 'nope' } },
      reason: 'r', evidence: {}, cost_usd: 0, reversible: true, level_required: 1, expires_at: '2026-09-09T00:00:00.000Z',
    }, NOW).id;
    await executeProposal(db, pid, deps(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));
    const payload = JSON.parse(selectEvents(db)[0]!.payload) as Record<string, unknown>;
    expect(payload.techpack_id).toBe(42);
    expect(payload.revision).toBe(2);
    expect(payload).not.toHaveProperty('extra');
    expect(payload.ok).toBe(true);
  });

  it('prefers the response value over the body fallback when both carry the same identifier key', async () => {
    const pid = insertProposal(db, {
      agent: 'sourcing-agent', brand_id: 'dearborn-denim', action_type: 'design_sheet',
      action_payload: { hand: 'ad-manager', method: 'POST', path: '/api/z', body: { id: 'body-id' } },
      reason: 'r', evidence: {}, cost_usd: 0, reversible: true, level_required: 1, expires_at: '2026-09-09T00:00:00.000Z',
    }, NOW).id;
    await executeProposal(db, pid, deps(async () => new Response(JSON.stringify({ id: 'response-id' }), { status: 200 })));
    const payload = JSON.parse(selectEvents(db)[0]!.payload) as Record<string, unknown>;
    expect(payload.id).toBe('response-id');
  });
});

describe('executeProposal: executed-event suppression for notes cards', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); initializeSchema(db); });
  afterEach(() => db.close());

  function insertNotesWithActionType(actionType: string): number {
    return insertProposal(db, {
      agent: 'ops-agent', brand_id: 'dearborn-denim', action_type: actionType,
      action_payload: { hand: 'notes', method: 'POST', path: '/note', body: { title: 't', summary: 's' } },
      reason: 'r', evidence: {}, cost_usd: 0, reversible: true, level_required: 1, expires_at: '2026-09-09T00:00:00.000Z',
    }, NOW).id;
  }

  it.each(['capacity_report', 'inventory_warning', 'fraud_alert', 'restock_flag'])(
    'never emits for a %s notes card',
    async (actionType) => {
      const id = insertNotesWithActionType(actionType);
      await executeProposal(db, id, deps(vi.fn()));
      expect(selectEvents(db)).toHaveLength(0);
    },
  );

  it('emits {} as the response for a non-suppressed notes card', async () => {
    const id = insertNotesWithActionType('design_sheet');
    await executeProposal(db, id, deps(vi.fn()));
    const events = selectEvents(db);
    expect(events).toHaveLength(1);
    expect(events[0]!.event_type).toBe('design_sheet_executed');
    const payload = JSON.parse(events[0]!.payload) as { response: unknown };
    expect(payload.response).toEqual({});
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

describe('extractNotify', () => {
  it('returns the trimmed notify string when present', () => {
    expect(extractNotify({ notify: '  Spend raised to $12k.  ' })).toBe('Spend raised to $12k.');
  });

  it('returns undefined when notify is absent', () => {
    expect(extractNotify({ ok: true })).toBeUndefined();
    expect(extractNotify({})).toBeUndefined();
  });

  it('truncates to 600 chars', () => {
    const long = 'x'.repeat(700);
    const r = extractNotify({ notify: long });
    expect(r).toHaveLength(600);
    expect(r).toBe('x'.repeat(600));
  });

  it('ignores a non-string notify field', () => {
    expect(extractNotify({ notify: 42 })).toBeUndefined();
    expect(extractNotify({ notify: { a: 1 } })).toBeUndefined();
    expect(extractNotify({ notify: null })).toBeUndefined();
    expect(extractNotify({ notify: ['x'] })).toBeUndefined();
  });

  it('strips control characters and treats a whitespace-only notify as absent', () => {
    expect(extractNotify({ notify: 'line1\nline2\tend' })).toBe('line1line2end');
    expect(extractNotify({ notify: '   \n\t  ' })).toBeUndefined();
  });

  it('ignores a non-object or array body', () => {
    expect(extractNotify(null)).toBeUndefined();
    expect(extractNotify('a string')).toBeUndefined();
    expect(extractNotify(['notify'])).toBeUndefined();
    expect(extractNotify(undefined)).toBeUndefined();
  });

  it('falls back to "title: summary" when notify is absent (the notes hand shape)', () => {
    expect(extractNotify({ title: 'Line 2 at capacity', summary: 'Utilization hit 92% this week.' }))
      .toBe('Line 2 at capacity: Utilization hit 92% this week.');
  });

  it('prefers an explicit notify over the title/summary fallback', () => {
    expect(extractNotify({ title: 't', summary: 's', notify: 'Custom notify wins.' })).toBe('Custom notify wins.');
  });

  it('falls back to title/summary when notify is present but empty', () => {
    expect(extractNotify({ title: 't', summary: 's', notify: '   ' })).toBe('t: s');
  });

  it('truncates the title/summary fallback to 600 chars', () => {
    const r = extractNotify({ title: 't', summary: 'x'.repeat(700) });
    expect(r).toHaveLength(600);
  });

  it('does not fall back when only one of title/summary is a string', () => {
    expect(extractNotify({ title: 't' })).toBeUndefined();
    expect(extractNotify({ summary: 's' })).toBeUndefined();
    expect(extractNotify({ title: 1, summary: 's' })).toBeUndefined();
  });
});
