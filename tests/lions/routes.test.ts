import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import { createLionsRouter } from '../../src/lions/routes.js';
import { addAlerts, getActiveAlerts, saveSnapshot } from '../../src/lions/store.js';
import { loadLionsPageTemplate } from '../../src/lions/page.js';
import type { LionsGame } from '../../src/lions/parse.js';
import type { LionsCheckResult } from '../../src/lions/check.js';

const SECRET = 's'.repeat(24);
const NOW = '2026-09-09T23:00:00.000Z';

const GAMES: LionsGame[] = [
  { week: 1, date: '2026-09-19', time: '2:00 PM', home: 'SOUTH LOOP', away: 'STEM', opponent: 'STEM', isHome: true, venue: 'Crane HS' },
  { week: 5, date: '2026-10-17', time: '2:00 PM', home: 'SOUTH LOOP', away: 'SKINNER', opponent: 'SKINNER', isHome: true, venue: 'Crane HS' },
];

function fakeReq(method: string, url: string, auth?: string): import('node:http').IncomingMessage {
  const listeners: Record<string, ((...a: unknown[]) => void)[]> = {};
  const req = {
    method, url, headers: auth ? { authorization: auth } : {},
    on(ev: string, fn: (...a: unknown[]) => void) { (listeners[ev] ??= []).push(fn); return req; },
    pause() { return req; }, destroy() { return req; },
  };
  queueMicrotask(() => listeners.end?.forEach((f) => f()));
  return req as unknown as import('node:http').IncomingMessage;
}

function fakeRes() {
  const out = { status: 0, body: '', headers: {} as Record<string, string> };
  const res = {
    writeHead(s: number, h?: Record<string, string>) { out.status = s; Object.assign(out.headers, h ?? {}); return res; },
    end(b?: string, cb?: () => void) { out.body = b ?? ''; cb?.(); },
  };
  return { res: res as unknown as import('node:http').ServerResponse, out };
}

const OK_RESULT: LionsCheckResult = {
  ok: true, baseline: false, sheetChanged: true, snapshotSaved: true,
  changes: [], notified: false, games: 6, checkedAt: NOW,
};

describe('lions routes', () => {
  let db: Database.Database;
  let runCheck: ReturnType<typeof vi.fn>;
  let handle: ReturnType<typeof createLionsRouter>;

  const build = (over: Partial<Parameters<typeof createLionsRouter>[0]> = {}) =>
    createLionsRouter({
      db,
      apiSecret: SECRET,
      runCheck: runCheck as unknown as () => Promise<LionsCheckResult>,
      now: () => NOW,
      env: {},
      renderPage: (data) => `<html>${JSON.stringify(data)}</html>`,
      ...over,
    });

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
    runCheck = vi.fn(async () => OK_RESULT);
    handle = build();
  });
  afterEach(() => db.close());

  it('ignores paths that are not /lions', async () => {
    const { res } = fakeRes();
    expect(await handle(fakeReq('GET', '/health'), res)).toBe(false);
    expect(await handle(fakeReq('GET', '/lionsomething'), res)).toBe(false);
  });

  it('GET /lions/schedule.json returns games, alerts, checkedAt and the source', async () => {
    saveSnapshot(db, GAMES, 'hash-1', NOW);
    addAlerts(db, [{
      week: 5, opponent: 'SKINNER', opponentLabel: 'Skinner', isHome: true,
      kind: 'time_changed', summary: 'Week 5 vs Skinner: 1:00 PM → 2:00 PM',
      before: '1:00 PM', after: '2:00 PM',
    }], NOW);

    const { res, out } = fakeRes();
    expect(await handle(fakeReq('GET', '/lions/schedule.json'), res)).toBe(true);
    expect(out.status).toBe(200);
    expect(out.headers['Cache-Control']).toBe('no-store');

    const body = JSON.parse(out.body) as {
      games: LionsGame[];
      alerts: { week: number; summary: string; before: string; cleared_at: string | null }[];
      checkedAt: string;
      source: { url: string; team: string; venue: string };
    };
    expect(body.games).toEqual(GAMES);
    expect(body.checkedAt).toBe(NOW);
    expect(body.alerts).toHaveLength(1);
    expect(body.alerts[0]).toMatchObject({ week: 5, summary: 'Week 5 vs Skinner: 1:00 PM → 2:00 PM', before: '1:00 PM', cleared_at: null });
    expect(body.source).toMatchObject({
      team: 'SOUTH LOOP',
      venue: 'Crane HS',
      url: 'https://docs.google.com/spreadsheets/d/1JHw7GN3iiXqzpEV0RxlYL4Uwk9e87jzRLJqCvC3g53A/export?format=csv&gid=974230082',
    });
  });

  it('GET /lions/schedule.json is empty but well-shaped before the first check', async () => {
    const { res, out } = fakeRes();
    await handle(fakeReq('GET', '/lions/schedule.json'), res);
    expect(JSON.parse(out.body)).toMatchObject({ games: [], alerts: [], checkedAt: null });
  });

  it('GET /lions serves the page with live data injected and no-store', async () => {
    saveSnapshot(db, GAMES, 'hash-1', NOW);
    const { res, out } = fakeRes();
    expect(await handle(fakeReq('GET', '/lions'), res)).toBe(true);
    expect(out.status).toBe(200);
    expect(out.headers['Content-Type']).toBe('text/html; charset=utf-8');
    expect(out.headers['Cache-Control']).toBe('no-store');
    const injected = JSON.parse(out.body.replace('<html>', '').replace('</html>', '')) as { live: boolean; games: LionsGame[] };
    expect(injected.live).toBe(true);
    expect(injected.games).toEqual(GAMES);
  });

  it('GET /lions marks live:false when nothing is stored yet', async () => {
    const { res, out } = fakeRes();
    await handle(fakeReq('GET', '/lions'), res);
    expect(JSON.parse(out.body.replace('<html>', '').replace('</html>', ''))).toMatchObject({ live: false, games: [] });
  });

  it('POST /lions/check runs the check and returns its result', async () => {
    const { res, out } = fakeRes();
    expect(await handle(fakeReq('POST', '/lions/check', `Bearer ${SECRET}`), res)).toBe(true);
    expect(out.status).toBe(200);
    expect(JSON.parse(out.body)).toEqual(OK_RESULT);
    expect(runCheck).toHaveBeenCalledTimes(1);
  });

  it('POST /lions/check reports a failed check as 502', async () => {
    runCheck = vi.fn(async () => ({ ok: false, error: 'CPS sheet returned HTTP 503' }));
    handle = build();
    const { res, out } = fakeRes();
    await handle(fakeReq('POST', '/lions/check', `Bearer ${SECRET}`), res);
    expect(out.status).toBe(502);
    expect(JSON.parse(out.body)).toEqual({ ok: false, error: 'CPS sheet returned HTTP 503' });
  });

  it('POST /lions/check is bearer-gated and fails closed with no secret', async () => {
    const missing = fakeRes();
    await handle(fakeReq('POST', '/lions/check'), missing.res);
    expect(missing.out.status).toBe(401);

    const wrong = fakeRes();
    await handle(fakeReq('POST', '/lions/check', 'Bearer nope'), wrong.res);
    expect(wrong.out.status).toBe(401);

    const unconfigured = fakeRes();
    await build({ apiSecret: '' })(fakeReq('POST', '/lions/check', `Bearer ${SECRET}`), unconfigured.res);
    expect(unconfigured.out.status).toBe(403);
    expect(runCheck).not.toHaveBeenCalled();
  });

  it('POST /lions/alerts/clear clears the active alerts', async () => {
    addAlerts(db, [
      { week: 5, opponent: 'SKINNER', opponentLabel: 'Skinner', isHome: true, kind: 'time_changed', summary: 'a', before: '1:00 PM', after: '2:00 PM' },
      { week: 6, opponent: 'STEM', opponentLabel: 'STEM', isHome: false, kind: 'game_removed', summary: 'b', before: 'x', after: null },
    ], NOW);
    expect(getActiveAlerts(db)).toHaveLength(2);

    const { res, out } = fakeRes();
    expect(await handle(fakeReq('POST', '/lions/alerts/clear', `Bearer ${SECRET}`), res)).toBe(true);
    expect(out.status).toBe(200);
    expect(JSON.parse(out.body)).toEqual({ cleared: 2 });
    expect(getActiveAlerts(db)).toEqual([]);

    // Idempotent.
    const again = fakeRes();
    await handle(fakeReq('POST', '/lions/alerts/clear', `Bearer ${SECRET}`), again.res);
    expect(JSON.parse(again.out.body)).toEqual({ cleared: 0 });
  });

  it('POST /lions/alerts/clear is bearer-gated', async () => {
    addAlerts(db, [{ week: 5, opponent: 'SKINNER', opponentLabel: 'Skinner', isHome: true, kind: 'time_changed', summary: 'a', before: '1', after: '2' }], NOW);
    const { res, out } = fakeRes();
    await handle(fakeReq('POST', '/lions/alerts/clear', 'Bearer nope'), res);
    expect(out.status).toBe(401);
    expect(getActiveAlerts(db)).toHaveLength(1);
  });

  it('unknown /lions/* paths and wrong methods are 404', async () => {
    for (const [method, url] of [['GET', '/lions/nope'], ['POST', '/lions'], ['GET', '/lions/check']] as const) {
      const { res, out } = fakeRes();
      expect(await handle(fakeReq(method, url, `Bearer ${SECRET}`), res)).toBe(true);
      expect(out.status).toBe(404);
    }
  });
});

describe('GET /lions with the real page template', () => {
  let db: Database.Database;

  beforeEach(() => { db = new Database(':memory:'); initializeSchema(db); });
  afterEach(() => db.close());

  it('replaces only the JSON inside the data block and escapes "</"', async () => {
    // A CPS "Notes" cell is free text — it must never be able to close the tag.
    const nasty: LionsGame[] = [{ ...GAMES[0]!, notes: 'moved</script><script>alert(1)</script>' }];
    saveSnapshot(db, nasty, 'hash-1', NOW);

    const handle = createLionsRouter({
      db, apiSecret: SECRET, runCheck: async () => OK_RESULT, now: () => NOW, env: {},
    });
    const { res, out } = fakeRes();
    await handle(fakeReq('GET', '/lions'), res);
    expect(out.status).toBe(200);

    const block = /<script id="lions-data" type="application\/json">([\s\S]*?)<\/script>/.exec(out.body);
    expect(block).not.toBeNull();
    const json = block![1]!;
    expect(json).toContain('<\\/script>');
    expect(json).not.toContain('</script>');
    const data = JSON.parse(json) as { live: boolean; games: LionsGame[]; checkedAt: string };
    expect(data.live).toBe(true);
    expect(data.checkedAt).toBe(NOW);
    expect(data.games[0]!.notes).toBe('moved</script><script>alert(1)</script>');

    // The rest of the page is untouched: the static artifact still works.
    const template = loadLionsPageTemplate();
    expect(out.body).toContain('var SCHEDULE = [');
    expect(out.body).toContain('id="alert-banner"');
    expect(out.body.length).toBeGreaterThan(template.length - 200);
  });

  it('serves the untouched empty data block when nothing is stored', async () => {
    const handle = createLionsRouter({
      db, apiSecret: SECRET, runCheck: async () => OK_RESULT, now: () => NOW, env: {},
    });
    const { res, out } = fakeRes();
    await handle(fakeReq('GET', '/lions'), res);
    expect(out.body).toContain('<script id="lions-data" type="application/json">{"games":[],"alerts":[],"checkedAt":null,"live":false}</script>');
  });
});
