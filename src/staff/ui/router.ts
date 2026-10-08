/**
 * `/staff/*` — Robert's staff admin UI (spec
 * docs/superpowers/specs/2026-10-08-staff-admin-ui-design.md). Mounted from
 * src/api.ts before the spine routes; answers only paths under /staff.
 *
 *   GET  /staff/login, POST /staff/login, POST /staff/logout
 *   GET  /staff (people), /staff/activity, /staff/activity.csv, /staff/agents, /staff/catalogue
 *   POST /staff/people/{grants,location,language,invite,add}, POST /staff/trust
 *
 * Unset STAFF_UI_PASSWORD or SPINE_ADMIN_TOKEN → 503 on every path. Every POST
 * but the login carries the session's CSRF token; every write is audited.
 */

import type http from 'node:http';
import type Database from 'better-sqlite3';
import { recordAdminAudit, revokeStaffSession, sweepStaffSessions } from '../../db/staff-ui-queries.js';
import { getTrustRow, promoteTrust } from '../../db/trust-queries.js';
import { getUserById } from '../../db/user-queries.js';
import { loadBrandConfig } from '../../spine/brand-config.js';
import type { TrustLevel } from '../../spine/types.js';
import type { StaffCatalogue } from '../catalogue.js';
import {
  FLASH_COOKIE, SESSION_COOKIE, clearedFlashCookie, clearedSessionCookie, createLoginLimiter, csrfToken, csrfValid,
  flashCookie, issueFlash, issueSession, passwordMatches, readCookie, readFlash, sessionCookie, uiSecretsFromEnv,
  verifySession, type LoginLimiter, type Notice, type UiSecrets,
} from './auth.js';
import { html, layout, type NavKey, type Safe } from './render.js';
import { postPeople, renderPeople } from './pages/people.js';
import { activityCsv, renderActivity } from './pages/activity.js';
import { renderAgents } from './pages/agents.js';
import { renderCatalogue } from './pages/catalogue.js';

export interface StaffUiDeps {
  db: Database.Database;
  env: Record<string, string | undefined>;
  brandsDir: string;
  now: () => string;
  catalogue: () => StaffCatalogue;
  limiter?: LoginLimiter;
}

/** What a page renderer or write handler sees. */
export interface PageCtx {
  db: Database.Database;
  csrf: string;
  brandsDir: string;
  nowIso: string;
  catalogue: StaffCatalogue;
  audit: (action: string, target: string | null, detail: Record<string, unknown>) => void;
}

export interface PostResult {
  notice: Notice;
  back: 'people' | 'agents';
}

const MAX_FORM_BYTES = 64 * 1024;
const ACTION_TYPE_RE = /^[a-z][a-z0-9_]{0,63}$/;

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

function send(res: http.ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

function redirect(res: http.ServerResponse, to: string, headers: Record<string, string> = {}): void {
  res.writeHead(303, { Location: to, ...SECURITY_HEADERS, ...headers });
  res.end();
}

/**
 * The client address for the login limiter: the LAST X-Forwarded-For entry,
 * the one Railway's edge proxy writes (there is no CDN in front). Earlier
 * entries come from the client and are spoofable, so they are never used.
 * With no header (a direct connection, tests) it is the socket address.
 */
export function clientIp(req: http.IncomingMessage): string {
  const xff = req.headers['x-forwarded-for'];
  const raw = Array.isArray(xff) ? xff.join(',') : xff;
  const last = raw?.split(',').map((s) => s.trim()).filter(Boolean).at(-1);
  return last || req.socket.remoteAddress || 'unknown';
}

function readForm(req: http.IncomingMessage): Promise<URLSearchParams | null> {
  return new Promise((resolve, reject) => {
    const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    if (type !== 'application/x-www-form-urlencoded') { req.resume(); resolve(null); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_FORM_BYTES) { req.destroy(); reject(new Error('form too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}

function loginPage(message?: string): string {
  return layout({
    title: 'Sign in', nav: null, notice: message ? { text: message, error: true } : null,
    body: html`<h1>McSecretary staff</h1>
<form method="post" action="/staff/login" class="row"><input type="password" name="password" autocomplete="current-password" required autofocus>
<button>Sign in</button></form>`,
  });
}

const PAGES: Record<string, { nav: NavKey; title: string; render: (ctx: PageCtx, q: URLSearchParams) => Safe }> = {
  '/staff': { nav: 'people', title: 'People', render: (ctx) => renderPeople(ctx) },
  '/staff/activity': { nav: 'activity', title: 'Activity', render: renderActivity },
  '/staff/agents': { nav: 'agents', title: 'Agents', render: renderAgents },
  '/staff/catalogue': { nav: 'catalogue', title: 'Catalogue', render: (ctx) => renderCatalogue(ctx) },
};

/** POST /staff/trust: one trust-ledger row to level 1, 2 or 3 via promoteTrust (by = 'staff-ui'). */
function postTrust(ctx: PageCtx, form: URLSearchParams): PostResult {
  const back = form.get('back') === 'agents' ? 'agents' : 'people';
  const agent = form.get('agent') ?? '';
  const brandId = form.get('brand_id') ?? '';
  const actionType = form.get('action_type') ?? '';
  const level = Number(form.get('level'));
  const bad = (text: string): PostResult => ({ notice: { text, error: true }, back });
  if (!agent || agent.length > 128 || !ACTION_TYPE_RE.test(actionType)) return bad('That trust row is not valid.');
  if (level !== 1 && level !== 2 && level !== 3) return bad('Level must be 1, 2 or 3.');
  try { loadBrandConfig(ctx.brandsDir, brandId); } catch { return bad(`Unknown brand ${brandId}.`); }
  const k = { agent, brand_id: brandId, action_type: actionType };
  const before = getTrustRow(ctx.db, k);
  const user = getUserById(ctx.db, agent);
  if (back === 'people' || user) {
    // A person: staff members only, and only the catalogue's write action types.
    if (!user || user.role !== 'member') return bad('No such staff member.');
    const staffTypes = new Set(Object.values(ctx.catalogue.actions).flatMap((a) => (a.kind === 'write' && a.action_type ? [a.action_type] : [])));
    if (!staffTypes.has(actionType)) return bad(`${actionType} is not a staff action.`);
  } else if (!before) {
    // A business agent: only rows its own filings created.
    return bad('No such trust row.');
  }
  const r = ctx.db.transaction(() => {
    const out = promoteTrust(ctx.db, k, level as TrustLevel, 'staff-ui', ctx.nowIso);
    if (out.ok) ctx.audit('set_trust', agent, { brand_id: brandId, action_type: actionType, before: before?.level ?? null, after: level });
    return out;
  })();
  if (!r.ok) {
    return bad(r.reason === 'pinned' ? `${actionType} is a pinned human gate and stays at level 1.` : 'Level must be 0–3.');
  }
  return { notice: { text: `${agent} · ${actionType} is now level ${level}.` }, back };
}

export function createStaffRouter(deps: StaffUiDeps) {
  const limiter = deps.limiter ?? createLoginLimiter();

  return async function handleStaff(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://staff.invalid');
    const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
    if (path !== '/staff' && !path.startsWith('/staff/')) return false;

    try {
      const secrets = uiSecretsFromEnv(deps.env);
      if (!secrets) {
        send(res, 503, layout({ title: 'Not configured', nav: null, body: html`<h1>Staff UI is not configured</h1><p>Set STAFF_UI_PASSWORD (and SPINE_ADMIN_TOKEN) on McSecretary.</p>` }));
        return true;
      }
      const nowMs = Date.parse(deps.now());
      const nonce = verifySession(secrets, deps.db, readCookie(req.headers.cookie, SESSION_COOKIE), nowMs);

      if (path === '/staff/login') {
        if (req.method === 'GET') {
          if (nonce) redirect(res, '/staff'); else send(res, 200, loginPage());
          return true;
        }
        if (req.method === 'POST') return await login(req, res, secrets, nowMs);
        send(res, 405, 'Method not allowed', { Allow: 'GET, POST' });
        return true;
      }

      if (!nonce) {
        if (req.method === 'GET') redirect(res, '/staff/login');
        else send(res, 401, loginPage('Your session has ended; sign in again.'));
        return true;
      }
      const csrf = csrfToken(secrets, nonce);
      const ctx: PageCtx = {
        db: deps.db, csrf, brandsDir: deps.brandsDir, nowIso: new Date(nowMs).toISOString(), catalogue: deps.catalogue(),
        audit: (action, target, detail) => recordAdminAudit(deps.db, { action, target, detail }, new Date(nowMs).toISOString()),
      };

      if (req.method === 'GET') {
        if (path === '/staff/activity.csv') {
          res.writeHead(200, {
            ...SECURITY_HEADERS, 'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="staff-activity-${ctx.nowIso.slice(0, 10)}.csv"`,
          });
          res.end(activityCsv(ctx, url.searchParams));
          return true;
        }
        const page = PAGES[path];
        if (!page) { send(res, 404, layout({ title: 'Not found', nav: null, csrf, body: html`<h1>Not found</h1>` })); return true; }
        const flashToken = readCookie(req.headers.cookie, FLASH_COOKIE);
        const notice = readFlash(secrets, nonce, flashToken, nowMs);
        send(res, 200, layout({ title: page.title, nav: page.nav, csrf, notice, body: page.render(ctx, url.searchParams) }),
          flashToken !== undefined ? { 'Set-Cookie': clearedFlashCookie() } : {});
        return true;
      }

      if (req.method !== 'POST') { send(res, 405, 'Method not allowed', { Allow: 'GET, POST' }); return true; }
      const form = await readForm(req);
      if (!form) { send(res, 415, 'Forms only'); return true; }
      if (!csrfValid(secrets, nonce, form.get('csrf'))) {
        send(res, 403, layout({ title: 'Refused', nav: null, body: html`<h1>Refused</h1><p>The form expired. <a href="/staff">Reload</a> and try again.</p>` }));
        return true;
      }

      if (path === '/staff/logout') {
        revokeStaffSession(deps.db, nonce, ctx.nowIso);
        redirect(res, '/staff/login', { 'Set-Cookie': clearedSessionCookie() });
        return true;
      }
      let result: PostResult | null = null;
      if (path === '/staff/trust') result = postTrust(ctx, form);
      else if (path.startsWith('/staff/people/')) result = postPeople(ctx, path.slice('/staff/people/'.length), form);
      if (!result) { send(res, 404, layout({ title: 'Not found', nav: null, csrf, body: html`<h1>Not found</h1>` })); return true; }
      const back = result.back === 'agents' ? '/staff/agents' : '/staff';
      if (result.notice.error) {
        // Errors render inline; nothing was written.
        const target = PAGES[back]!;
        send(res, 400, layout({ title: target.title, nav: target.nav, csrf, notice: result.notice, body: target.render(ctx, new URLSearchParams()) }));
        return true;
      }
      // Post/Redirect/Get: the one-time notice (e.g. an invite code) rides a 60 s signed cookie.
      redirect(res, back, { 'Set-Cookie': flashCookie(issueFlash(secrets, nonce, result.notice, nowMs)) });
      return true;
    } catch (err) {
      console.error('staff-ui: request failed', req.method, path, err);
      if (!res.headersSent) send(res, 500, layout({ title: 'Error', nav: null, body: html`<h1>Something went wrong</h1><p>Nothing more was changed. Try again.</p>` }));
      else res.end();
      return true;
    }
  };

  async function login(req: http.IncomingMessage, res: http.ServerResponse, secrets: UiSecrets, nowMs: number): Promise<boolean> {
    const ip = clientIp(req);
    // Counted before the body is awaited, so concurrent attempts share one budget.
    if (!limiter.take(ip, nowMs)) {
      req.resume();
      send(res, 429, loginPage('Too many attempts. Try again in 15 minutes.'), { 'Retry-After': '900' });
      return true;
    }
    const form = await readForm(req);
    const password = form?.get('password') ?? '';
    if (!passwordMatches(password, secrets.password)) {
      send(res, 401, loginPage('Wrong password.'));
      return true;
    }
    limiter.succeed(ip);
    const nowIso = new Date(nowMs).toISOString();
    const token = deps.db.transaction(() => {
      sweepStaffSessions(deps.db, nowIso);
      recordAdminAudit(deps.db, { action: 'login', target: null, detail: { ip } }, nowIso);
      return issueSession(secrets, deps.db, nowMs);
    })();
    redirect(res, '/staff', { 'Set-Cookie': sessionCookie(token) });
    return true;
  }
}
