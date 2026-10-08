import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import { createUser, getUserById } from '../../src/db/user-queries.js';
import { insertProposal } from '../../src/db/proposal-queries.js';
import { loadCatalogue } from '../../src/staff/catalogue.js';
import { createStaffRouter } from '../../src/staff/ui/router.js';
import { issueSession, SESSION_TTL_MS } from '../../src/staff/ui/auth.js';

const SECRETS = { password: 'correct horse', hmacKey: 'spine-admin-token-0123456789' };
const ENV = { STAFF_UI_PASSWORD: SECRETS.password, SPINE_ADMIN_TOKEN: SECRETS.hmacKey };
const cat = loadCatalogue(path.join(process.cwd(), 'config', 'staff-actions.json'));
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

describe('staff admin UI', () => {
  let db: Database.Database;
  let server: http.Server;
  let base: string;
  const clock = { now: '2026-10-08T15:00:00.000Z' };

  async function start(env: Record<string, string | undefined> = ENV): Promise<void> {
    const handle = createStaffRouter({ db, env, brandsDir: path.join(process.cwd(), 'config', 'brands'), now: () => clock.now, catalogue: () => cat });
    server = http.createServer(async (req, res) => { if (!(await handle(req, res))) { res.writeHead(404); res.end(); } });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  const login = (password: string) =>
    fetch(`${base}/staff/login`, { method: 'POST', redirect: 'manual', headers: FORM, body: new URLSearchParams({ password }).toString() });

  async function session(): Promise<{ cookie: string; csrf: string }> {
    const r = await login(SECRETS.password);
    const cookie = r.headers.get('set-cookie')!.split(';')[0]!;
    const page = await (await fetch(`${base}/staff`, { headers: { cookie } })).text();
    return { cookie, csrf: /name="csrf" value="([^"]+)"/.exec(page)![1]! };
  }

  beforeEach(() => {
    db = new Database(':memory:'); initializeSchema(db);
    createUser(db, { id: 'kristina', name: 'Kristina', email: 'k@dd.com', role: 'member' });
    clock.now = '2026-10-08T15:00:00.000Z';
  });
  afterEach(async () => {
    await new Promise((r) => server.close(r));
    db.close();
  });

  it('answers 503 on every path when STAFF_UI_PASSWORD is unset', async () => {
    await start({ SPINE_ADMIN_TOKEN: SECRETS.hmacKey });
    expect((await fetch(`${base}/staff`)).status).toBe(503);
    expect((await login('anything')).status).toBe(503);
  });

  it('refuses a wrong password, and after 5 failures refuses even the right one with 429', async () => {
    await start();
    const wrong = await login('wrong');
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get('set-cookie')).toBeNull();
    for (let i = 0; i < 4; i++) expect((await login('wrong')).status).toBe(401);
    const blocked = await login(SECRETS.password);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('set-cookie')).toBeNull();

    // The window is 15 minutes.
    clock.now = '2026-10-08T15:15:01.000Z';
    const ok = await login(SECRETS.password);
    expect(ok.status).toBe(303);
    expect(ok.headers.get('set-cookie')).toMatch(/^staff_session=v1\.[^;]+; Path=\/staff; HttpOnly; Secure; SameSite=Lax; Max-Age=604800$/);
  });

  it('refuses a forged, tampered or expired session cookie', async () => {
    await start();
    const { cookie } = await session();
    expect((await fetch(`${base}/staff`, { headers: { cookie } })).status).toBe(200);

    const nowMs = Date.parse(clock.now);
    const forged = issueSession({ password: SECRETS.password, hmacKey: 'some-other-key' }, nowMs);
    const [v, exp, nonce, sig] = cookie.slice('staff_session='.length).split('.');
    const extended = `${v}.${Number(exp) + 1000}.${nonce}.${sig}`;
    for (const bad of [`staff_session=${forged}`, `staff_session=${extended}`, 'staff_session=v1.9999999999999.x.y', 'staff_session=']) {
      const r = await fetch(`${base}/staff`, { headers: { cookie: bad }, redirect: 'manual' });
      expect(r.status).toBe(303);
      expect(r.headers.get('location')).toBe('/staff/login');
    }

    // Seven days later the genuine cookie has expired.
    clock.now = new Date(nowMs + SESSION_TTL_MS).toISOString();
    expect((await fetch(`${base}/staff`, { headers: { cookie }, redirect: 'manual' })).status).toBe(303);
  });

  it('refuses a write with a missing or foreign CSRF token and changes nothing', async () => {
    await start();
    const { cookie, csrf } = await session();
    const other = await session();
    expect(other.csrf).not.toBe(csrf);
    const post = (body: Record<string, string>) =>
      fetch(`${base}/staff/people/grants`, { method: 'POST', headers: { ...FORM, cookie }, body: new URLSearchParams({ user_id: 'kristina', groups: 'store', ...body }).toString() });

    expect((await post({})).status).toBe(403);
    expect((await post({ csrf: other.csrf })).status).toBe(403);
    expect(getUserById(db, 'kristina')!.grants_json).toBe('[]');
    expect(db.prepare("SELECT COUNT(*) AS n FROM admin_audit WHERE action != 'login'").get()).toEqual({ n: 0 });

    expect((await post({ csrf })).status).toBe(200);
    expect(getUserById(db, 'kristina')!.grants_json).toBe('["store"]');
    expect(db.prepare("SELECT actor, action, target FROM admin_audit WHERE action != 'login'").all())
      .toEqual([{ actor: 'staff-ui', action: 'set_grants', target: 'kristina' }]);
  });

  it('escapes a proposal reason containing <script> on the activity page', async () => {
    insertProposal(db, {
      agent: 'kristina', brand_id: 'dearborn-denim', action_type: 'ops_note',
      action_payload: { hand: 'notes', method: 'POST', path: '/note', body: { title: 't', summary: '"><img src=x onerror=alert(2)>' } },
      reason: '<script>alert(1)</script> & more', evidence: { requested_by: 'Kristina', request_text: '</pre><script>alert(3)</script>' },
      cost_usd: 0, reversible: true, level_required: 1, expires_at: '2026-10-09T15:00:00.000Z',
    }, clock.now);
    await start();
    const { cookie } = await session();
    const page = await (await fetch(`${base}/staff/activity`, { headers: { cookie } })).text();
    expect(page).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; more');
    expect(page).not.toMatch(/<script|<img/i);
  });
});
