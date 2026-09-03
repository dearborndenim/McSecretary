import type Database from 'better-sqlite3';
import { getProposalById, recordExecution } from '../db/proposal-queries.js';
import { resolveHand, type BrandConfig } from './brand-config.js';
import type { ActionPayload } from './types.js';

export interface ExecutorDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  env: Record<string, string | undefined>;
  loadBrand: (brandId: string) => BrandConfig;
  now: () => string;
}

export type ExecutionResult =
  | { ok: true; http_status: number; body: unknown; recorded?: boolean }
  | { ok: false; http_status?: number; body?: unknown; error?: string; recorded?: boolean };

const EXECUTABLE = new Set(['pending', 'approved', 'approved_with_edit']);
const METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** Max chars of a hand's response body persisted on the proposal row. */
const STORED_BODY_CAP = 16384;

/**
 * Resolve a hand-relative path against the hand's base URL; refuse anything
 * that leaves the hand's origin and base path. `path` is agent-supplied, so
 * it is never concatenated raw — `@`, `//`, `:port`, `?`, `#`, `\\` and `..`
 * would otherwise move the request (and the hand's bearer) off-origin.
 */
export function resolveHandUrl(baseUrl: string, path: string): { ok: true; href: string } | { ok: false; error: string } {
  if (typeof path !== 'string' || !/^\/(?!\/)/.test(path)) {
    return { ok: false, error: `Invalid path: must start with a single '/'` };
  }
  // RFC 3986 pchar allowlist (unreserved + sub-delims + ':' + '/' + pct-encoding).
  // Positive match, so '@', '?', '#', '\\', whitespace and control chars are all refused.
  if (!/^\/[A-Za-z0-9._~%!$&'()*+,;=:\/-]*$/.test(path)) {
    return { ok: false, error: 'Invalid path: only unreserved and sub-delim characters are allowed' };
  }
  let base: URL;
  let u: URL;
  try {
    base = new URL(baseUrl);
    const basePath = base.pathname.replace(/\/*$/, '');
    u = new URL(basePath + path, base.origin);
    if (u.origin !== base.origin || !u.pathname.startsWith(`${basePath}/`)) {
      return { ok: false, error: 'Path escapes hand origin' };
    }
  } catch {
    return { ok: false, error: 'Invalid hand URL or path' };
  }
  return { ok: true, href: u.href };
}

function validatePayload(payload: ActionPayload): string | null {
  if (!METHODS.has(payload.method)) return `Invalid method: ${String(payload.method)}`;
  if (typeof payload.body !== 'object' || payload.body === null || Array.isArray(payload.body)) {
    return 'Invalid body: must be a JSON object';
  }
  return null;
}

/**
 * Call the hand named in `action_payload` with the payload verbatim, record
 * the result on the proposal, and never throw. Nothing about the hand's
 * bearer is written to the row.
 */
export async function executeProposal(
  db: Database.Database,
  id: number,
  deps: ExecutorDeps,
): Promise<ExecutionResult> {
  const row = getProposalById(db, id);
  if (!row) return { ok: false, error: `No proposal ${id}` };
  if (!EXECUTABLE.has(row.status)) return { ok: false, error: `Proposal ${id} is ${row.status}` };

  const fail = (error: string): ExecutionResult => {
    const recorded = recordExecution(db, id, 'failed', { error, at: deps.now() });
    return { ok: false, error, recorded };
  };

  let payload: ActionPayload;
  let target: { url: string; bearer: string };
  try {
    payload = JSON.parse(row.action_payload) as ActionPayload;
    target = resolveHand(deps.loadBrand(row.brand_id), payload.hand, deps.env);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }

  const invalid = validatePayload(payload);
  if (invalid) return fail(invalid);
  const resolved = resolveHandUrl(target.url, payload.path);
  if (!resolved.ok) return fail(resolved.error);

  try {
    const res = await deps.fetch(resolved.href, {
      method: payload.method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${target.bearer}` },
      body: JSON.stringify(payload.body),
    });
    const text = await res.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* keep text */ }
    const storedText = text.length > STORED_BODY_CAP ? `${text.slice(0, STORED_BODY_CAP)}…[truncated]` : text;
    let storedBody: unknown = storedText;
    try { storedBody = JSON.parse(storedText); } catch { /* keep text */ }
    const result = { http_status: res.status, body: storedBody, at: deps.now() };
    if (res.status >= 200 && res.status < 300) {
      const recorded = recordExecution(db, id, 'executed', result);
      return { ok: true, http_status: res.status, body, recorded };
    }
    const recorded = recordExecution(db, id, 'failed', result);
    return { ok: false, http_status: res.status, body, recorded };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
