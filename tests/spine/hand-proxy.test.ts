import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import { initializeSchema } from '../../src/db/schema.js';
import { createSpineRouter, type SpineRouterDeps } from '../../src/spine/api-routes.js';

const KEY = 'k'.repeat(24);
function fakeReq(method: string, url: string, auth?: string) {
  const listeners: Record<string, ((...a: unknown[]) => void)[]> = {};
  const req = { method, url, headers: auth ? { authorization: auth } : {}, destroyed: false,
    on(ev: string, fn: (...a: unknown[]) => void) { (listeners[ev] ??= []).push(fn); return req; }, pause() {}, destroy() { req.destroyed = true; } };
  queueMicrotask(() => listeners.end?.forEach((f) => f()));
  return req as unknown as import('node:http').IncomingMessage;
}
function fakeRes() {
  const out = { status: 0, body: '' };
  const res = { writeHead(s: number) { out.status = s; return res; }, end(b?: string, cb?: () => void) { out.body = b ?? ''; cb?.(); } };
  return { res: res as unknown as import('node:http').ServerResponse, out };
}

describe('GET /spine/hands/:hand/*', () => {
  let db: Database.Database;
  let fetchMock: ReturnType<typeof vi.fn>;
  let handle: ReturnType<typeof createSpineRouter>;
  const build = (env: Record<string, string | undefined>) => {
    const deps: SpineRouterDeps = {
      db, now: () => '2026-09-07T12:00:00.000Z', agentKeys: new Map([[KEY, 'finance']]),
      brandsDir: path.join(process.cwd(), 'config', 'brands'),
      file: async () => ({ id: 1, routed: 'card' }),
      handFetch: fetchMock as unknown as SpineRouterDeps['handFetch'],
      env,
    };
    return createSpineRouter(deps);
  };
  beforeEach(() => {
    db = new Database(':memory:'); initializeSchema(db);
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ rows: [1] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    handle = build({ CONTENT_ENGINE_URL: 'https://ce.example/', CONTENT_ENGINE_KEY: 'hk' });
  });
  afterEach(() => db.close());

  it('proxies a GET to the hand with the hand bearer and returns the body', async () => {
    const { res, out } = fakeRes();
    await handle(fakeReq('GET', '/spine/hands/content-engine/api/scoreboard?days=7&brand=dearborn-denim', `Bearer ${KEY}`), res);
    expect(out.status).toBe(200);
    expect(JSON.parse(out.body)).toEqual({ rows: [1] });
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('https://ce.example/api/scoreboard?days=7');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer hk');
    expect(init.method).toBe('GET');
    expect(init.signal).toBeUndefined(); // deps.handFetch owns the timeout
  });

  it('re-encodes query values as application/x-www-form-urlencoded (space → +, literal + → %2B)', async () => {
    const { res, out } = fakeRes();
    await handle(fakeReq('GET', '/spine/hands/content-engine/api/x?q=a%20b&x=1%2B2&brand=dearborn-denim', `Bearer ${KEY}`), res);
    expect(out.status).toBe(200);
    expect((fetchMock.mock.calls[0]! as unknown as [string])[0]).toBe('https://ce.example/api/x?q=a+b&x=1%2B2');
    // A raw '+' in the incoming query already means a space, so it round-trips as '+'.
    await handle(fakeReq('GET', '/spine/hands/content-engine/api/x?x=1+2&brand=dearborn-denim', `Bearer ${KEY}`), fakeRes().res);
    expect((fetchMock.mock.calls[1]! as unknown as [string])[0]).toBe('https://ce.example/api/x?x=1+2');
  });

  it('answers 502 when the streamed body exceeds 1 MiB, never truncating', async () => {
    const chunk = new Uint8Array(1_048_576).fill(0x61);
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({ pull(c) { if (pulls++ < 3) c.enqueue(chunk); else c.close(); } }, { highWaterMark: 0 });
    fetchMock.mockResolvedValueOnce(new Response(body, { status: 200, headers: { 'Content-Type': 'text/plain' } }));
    const { res, out } = fakeRes();
    await handle(fakeReq('GET', '/spine/hands/content-engine/api/x?brand=dearborn-denim', `Bearer ${KEY}`), res);
    expect(out.status).toBe(502);
    expect(JSON.parse(out.body)).toEqual({ error: 'Hand response too large', hand_status: 200 });
    expect(pulls).toBeLessThan(3);
  });

  it('answers 502 on an oversize Content-Length without reading the body', async () => {
    let pulled = false;
    const body = new ReadableStream<Uint8Array>({ pull(c) { pulled = true; c.enqueue(new Uint8Array(1)); c.close(); } }, { highWaterMark: 0 });
    fetchMock.mockResolvedValueOnce(new Response(body, { status: 200, headers: { 'Content-Length': '5000000' } }));
    const { res, out } = fakeRes();
    await handle(fakeReq('GET', '/spine/hands/content-engine/api/x?brand=dearborn-denim', `Bearer ${KEY}`), res);
    expect(out.status).toBe(502);
    expect(JSON.parse(out.body)).toEqual({ error: 'Hand response too large', hand_status: 200 });
    expect(pulled).toBe(false);
  });

  it('requires brand=, refuses unknown hand, and refuses non-GET', async () => {
    let r = fakeRes();
    await handle(fakeReq('GET', '/spine/hands/content-engine/api/x', `Bearer ${KEY}`), r.res);
    expect(r.out.status).toBe(400);
    r = fakeRes();
    await handle(fakeReq('GET', '/spine/hands/nope/api/x?brand=dearborn-denim', `Bearer ${KEY}`), r.res);
    expect(r.out.status).toBe(404);
    r = fakeRes();
    await handle(fakeReq('GET', `/spine/hands/${'h'.repeat(300)}/api/x?brand=dearborn-denim`, `Bearer ${KEY}`), r.res);
    expect(r.out.status).toBe(404);
    expect(JSON.parse(r.out.body).error).toBe(`Unknown hand: ${'h'.repeat(64)}`);
    r = fakeRes();
    await handle(fakeReq('GET', '/spine/hands/content-engine/api/x?brand=no-such-brand', `Bearer ${KEY}`), r.res);
    expect(r.out.status).toBe(404);
    r = fakeRes();
    await handle(fakeReq('POST', '/spine/hands/content-engine/api/x?brand=dearborn-denim', `Bearer ${KEY}`), r.res);
    expect(r.out.status).toBe(405);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers 404 (not 500) when the hand env is not configured, without leaking env names', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const h = build({});
      const { res, out } = fakeRes();
      await h(fakeReq('GET', '/spine/hands/content-engine/api/x?brand=dearborn-denim', `Bearer ${KEY}`), res);
      expect(out.status).toBe(404);
      expect(out.body).not.toContain('CONTENT_ENGINE');
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('refuses paths that escape the hand origin', async () => {
    // Base URL carries a path (/api) so both traversal forms leave the hand's prefix.
    const h = build({ CONTENT_ENGINE_URL: 'https://ce.example/api', CONTENT_ENGINE_KEY: 'hk' });
    for (const p of ['/spine/hands/content-engine/..%2f..%2fadmin', '/spine/hands/content-engine/x/../../admin', '/spine/hands/content-engine/@evil.com/x']) {
      const { res, out } = fakeRes();
      await h(fakeReq('GET', `${p}?brand=dearborn-denim`, `Bearer ${KEY}`), res);
      expect(out.status, p).toBe(400);
    }
    // '@' is refused regardless of base shape.
    const { res, out } = fakeRes();
    await handle(fakeReq('GET', '/spine/hands/content-engine/@evil.com/x?brand=dearborn-denim', `Bearer ${KEY}`), res);
    expect(out.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('passes the hand status through and never the bearer', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 503 }));
    const { res, out } = fakeRes();
    await handle(fakeReq('GET', '/spine/hands/content-engine/api/x?brand=dearborn-denim', `Bearer ${KEY}`), res);
    expect(out.status).toBe(502);
    expect(out.body).not.toContain('hk');
    expect(JSON.parse(out.body).hand_status).toBe(503);
  });

  it('maps a throwing handFetch to the generic 500', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED hk'));
      const { res, out } = fakeRes();
      await handle(fakeReq('GET', '/spine/hands/content-engine/api/x?brand=dearborn-denim', `Bearer ${KEY}`), res);
      expect(out.status).toBe(500);
      expect(JSON.parse(out.body)).toEqual({ error: 'Internal error' });
    } finally {
      spy.mockRestore();
    }
  });
});
