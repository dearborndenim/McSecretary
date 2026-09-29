import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
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

  const CAP = 8 * 1024 * 1024;

  it('answers 502 when the streamed body exceeds the 8 MiB cap by one byte, never truncating', async () => {
    const first = new Uint8Array(CAP).fill(0x61); // exactly at the cap
    const second = new Uint8Array(1).fill(0x62); // pushes total to CAP + 1
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (pulls === 0) c.enqueue(first);
        else if (pulls === 1) c.enqueue(second);
        else c.close();
        pulls++;
      },
    }, { highWaterMark: 0 });
    fetchMock.mockResolvedValueOnce(new Response(body, { status: 200, headers: { 'Content-Type': 'text/plain' } }));
    const { res, out } = fakeRes();
    await handle(fakeReq('GET', '/spine/hands/content-engine/api/x?brand=dearborn-denim', `Bearer ${KEY}`), res);
    expect(out.status).toBe(502);
    expect(JSON.parse(out.body)).toEqual({ error: 'Hand response too large', hand_status: 200 });
    expect(pulls).toBeLessThan(3);
  });

  it('answers 502 on a Content-Length one byte over the 8 MiB cap without reading the body', async () => {
    let pulled = false;
    const body = new ReadableStream<Uint8Array>({ pull(c) { pulled = true; c.enqueue(new Uint8Array(1)); c.close(); } }, { highWaterMark: 0 });
    fetchMock.mockResolvedValueOnce(new Response(body, { status: 200, headers: { 'Content-Length': String(CAP + 1) } }));
    const { res, out } = fakeRes();
    await handle(fakeReq('GET', '/spine/hands/content-engine/api/x?brand=dearborn-denim', `Bearer ${KEY}`), res);
    expect(out.status).toBe(502);
    expect(JSON.parse(out.body)).toEqual({ error: 'Hand response too large', hand_status: 200 });
    expect(pulled).toBe(false);
  });

  it('passes a 1.2 MB body (design-module collections-sized) through intact as 200', async () => {
    const size = 1_258_291; // ~1.2 MiB — bigger than the old 1 MiB cap, well under the new 8 MiB one
    const payload = Buffer.alloc(size);
    for (let i = 0; i < size; i++) payload[i] = 0x61 + (i % 26);
    const text = payload.toString('utf8');
    fetchMock.mockResolvedValueOnce(new Response(text, { status: 200, headers: { 'Content-Type': 'application/json', 'Content-Length': String(size) } }));
    const { res, out } = fakeRes();
    await handle(fakeReq('GET', '/spine/hands/content-engine/api/x?brand=dearborn-denim', `Bearer ${KEY}`), res);
    expect(out.status).toBe(200);
    expect(out.body.length).toBe(size);
    expect(out.body).toBe(text);
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

  describe('forward_brand', () => {
    const DM_ENV = {
      DESIGN_MODULE_URL: 'https://dm.example', DESIGN_MODULE_KEY: 'dk',
      PRODUCT_DEV_URL: 'https://pd.example', PRODUCT_DEV_KEY: 'pk',
      PO_RECEIVER_URL: 'https://po.example', PO_RECEIVER_API_KEY: 'pok',
    };
    const upstreamUrl = (i = 0) => (fetchMock.mock.calls[i]! as unknown as [string])[0];

    it('sets brand=<spine brand> upstream for a hand that opts in (design-module)', async () => {
      const h = build(DM_ENV);
      const { res, out } = fakeRes();
      await h(fakeReq('GET', '/spine/hands/design-module/api/collections?brand=dearborn-denim&limit=5', `Bearer ${KEY}`), res);
      expect(out.status).toBe(200);
      expect(upstreamUrl()).toBe('https://dm.example/api/collections?limit=5&brand=dearborn-denim');
    });

    it('keeps a caller-supplied brandSlug when the forward key is brand (product-dev: brandSlug wins there)', async () => {
      const h = build(DM_ENV);
      await h(fakeReq('GET', '/spine/hands/product-dev/api/integration/products?brandSlug=dearborn-denim&brand=dearborn-denim', `Bearer ${KEY}`), fakeRes().res);
      expect(upstreamUrl()).toBe('https://pd.example/api/integration/products?brandSlug=dearborn-denim&brand=dearborn-denim');
    });

    it('forwards nothing to a hand without the flag, even when brand means something else there', async () => {
      const h = build(DM_ENV);
      await h(fakeReq('GET', '/spine/hands/purchase-order-receiver/api/pos?brand=dearborn-denim&status=open', `Bearer ${KEY}`), fakeRes().res);
      expect(upstreamUrl()).toBe('https://po.example/api/pos?status=open');
    });

    it('knits reads design-module with brand=knits on the shared service', async () => {
      const h = build(DM_ENV);
      const { res, out } = fakeRes();
      await h(fakeReq('GET', '/spine/hands/design-module/api/config/personas?brand=knits', `Bearer ${KEY}`), res);
      expect(out.status).toBe(200);
      expect(upstreamUrl()).toBe('https://dm.example/api/config/personas?brand=knits');
    });

    it('knits ad-manager (env deliberately unset) answers 404 without calling out or throwing', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        // Dearborn's own AD_MANAGER_URL being set must not leak across to knits.
        const h = build({ ...DM_ENV, AD_MANAGER_URL: 'https://am.example', AD_MANAGER_KEY: 'ak' });
        const { res, out } = fakeRes();
        await h(fakeReq('GET', '/spine/hands/ad-manager/api/integration/matured-week?brand=knits', `Bearer ${KEY}`), res);
        expect(out.status).toBe(404);
        expect(JSON.parse(out.body)).toEqual({ error: 'Unknown brand or hand' });
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });

    describe('with a brand whose hand forwards under brandSlug', () => {
      let tmp: string;
      let h: ReturnType<typeof createSpineRouter>;
      beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brands-'));
        const cfg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'config', 'brands', 'dearborn-denim.json'), 'utf8')) as Record<string, unknown>;
        fs.writeFileSync(path.join(tmp, 'knits.json'), JSON.stringify({
          ...cfg, brand_id: 'knits',
          hands: { 'product-dev': { url_env: 'PRODUCT_DEV_URL', key_env: 'PRODUCT_DEV_KEY', forward_brand: 'brandSlug' } },
        }));
        h = createSpineRouter({
          db, now: () => '2026-09-07T12:00:00.000Z', agentKeys: new Map([[KEY, 'finance']]), brandsDir: tmp,
          file: async () => ({ id: 1, routed: 'card' }),
          handFetch: fetchMock as unknown as SpineRouterDeps['handFetch'], env: DM_ENV,
        });
      });
      afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

      it('a caller cannot read another brand by sending the forward key itself', async () => {
        await h(fakeReq('GET', '/spine/hands/product-dev/api/integration/products?brandSlug=dearborn-denim&brandSlug=other&brand=knits', `Bearer ${KEY}`), fakeRes().res);
        expect(upstreamUrl()).toBe('https://pd.example/api/integration/products?brandSlug=knits');
      });
    });
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
