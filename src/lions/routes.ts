/**
 * HTTP surface for the Lions schedule checker. Mounted the same way the spine
 * router is: `src/api.ts` calls this first and falls through when it returns
 * false.
 *
 *   GET  /lions                → the team page, live data injected (public)
 *   GET  /lions/schedule.json  → { games, alerts, checkedAt, source } (public)
 *   POST /lions/check          → run the check now (bearer API_SECRET)
 *   POST /lions/alerts/clear   → clear active alerts (bearer API_SECRET)
 *
 * The two public routes are no-store: Robert opens the page on his phone right
 * after a change lands and must not get a cached copy.
 */

import type http from 'node:http';
import type Database from 'better-sqlite3';
import { lionsConfig, lionsCsvUrl } from './config.js';
import { renderLionsPage } from './page.js';
import { clearAlerts, getActiveAlerts, getLatestSnapshot } from './store.js';
import type { LionsCheckResult } from './check.js';

export interface LionsRouterDeps {
  db: Database.Database;
  /** Same secret as the other admin routes; empty means "reject everything". */
  apiSecret: string;
  runCheck: () => Promise<LionsCheckResult>;
  now: () => string;
  env?: Record<string, string | undefined>;
  /** Injected in tests so the router does not need the real 70 KB page. */
  renderPage?: typeof renderLionsPage;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

/** Returns null when authorized, or the response to send. */
function adminGate(
  apiSecret: string,
  req: http.IncomingMessage,
): { status: number; body: unknown } | null {
  if (!apiSecret) return { status: 403, body: { error: 'API authentication not configured' } };
  if (req.headers.authorization !== `Bearer ${apiSecret}`) return { status: 401, body: { error: 'Unauthorized' } };
  return null;
}

export function buildSchedulePayload(deps: Pick<LionsRouterDeps, 'db' | 'env'>): {
  games: unknown[];
  alerts: unknown[];
  checkedAt: string | null;
  source: { url: string; team: string; venue: string; sheetId: string; gid: string };
} {
  const cfg = lionsConfig(deps.env ?? process.env);
  const snapshot = getLatestSnapshot(deps.db);
  return {
    games: snapshot?.games ?? [],
    alerts: getActiveAlerts(deps.db),
    checkedAt: snapshot?.taken_at ?? null,
    source: { url: lionsCsvUrl(cfg), team: cfg.team, venue: cfg.venue, sheetId: cfg.sheetId, gid: cfg.gid },
  };
}

export function createLionsRouter(deps: LionsRouterDeps) {
  const renderPage = deps.renderPage ?? renderLionsPage;

  return async function handleLionsRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<boolean> {
    const url = req.url ?? '';
    const [pathname] = url.split('?', 1) as [string];
    if (pathname !== '/lions' && !pathname.startsWith('/lions/')) return false;

    try {
      if (req.method === 'GET' && pathname === '/lions') {
        const payload = buildSchedulePayload(deps);
        const html = renderPage({
          games: payload.games as never,
          alerts: payload.alerts as never,
          checkedAt: payload.checkedAt,
          live: payload.games.length > 0,
        });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(html);
        return true;
      }

      if (req.method === 'GET' && pathname === '/lions/schedule.json') {
        json(res, 200, buildSchedulePayload(deps));
        return true;
      }

      if (req.method === 'POST' && pathname === '/lions/check') {
        const denied = adminGate(deps.apiSecret, req);
        if (denied) { json(res, denied.status, denied.body); return true; }
        const result = await deps.runCheck();
        json(res, result.ok ? 200 : 502, result);
        return true;
      }

      if (req.method === 'POST' && pathname === '/lions/alerts/clear') {
        const denied = adminGate(deps.apiSecret, req);
        if (denied) { json(res, denied.status, denied.body); return true; }
        const cleared = clearAlerts(deps.db, deps.now());
        json(res, 200, { cleared });
        return true;
      }

      json(res, 404, { error: 'Not found' });
      return true;
    } catch (err) {
      console.error('lions route error', pathname, err);
      json(res, 500, { error: 'Internal error' });
      return true;
    }
  };
}
