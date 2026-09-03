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
  | { ok: true; http_status: number; body: unknown }
  | { ok: false; http_status?: number; body?: unknown; error?: string };

const EXECUTABLE = new Set(['pending', 'approved', 'approved_with_edit']);

/**
 * Call the hand named in `action_payload` with the payload verbatim, record
 * the result on the proposal, and never throw.
 */
export async function executeProposal(
  db: Database.Database,
  id: number,
  deps: ExecutorDeps,
): Promise<ExecutionResult> {
  const row = getProposalById(db, id);
  if (!row) return { ok: false, error: `No proposal ${id}` };
  if (!EXECUTABLE.has(row.status)) return { ok: false, error: `Proposal ${id} is ${row.status}` };

  let payload: ActionPayload;
  let target: { url: string; bearer: string };
  try {
    payload = JSON.parse(row.action_payload) as ActionPayload;
    target = resolveHand(deps.loadBrand(row.brand_id), payload.hand, deps.env);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    recordExecution(db, id, 'failed', { error, at: deps.now() });
    return { ok: false, error };
  }

  try {
    const res = await deps.fetch(`${target.url}${payload.path}`, {
      method: payload.method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${target.bearer}` },
      body: JSON.stringify(payload.body),
    });
    const text = await res.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* keep text */ }
    const result = { http_status: res.status, body, at: deps.now() };
    if (res.status >= 200 && res.status < 300) {
      recordExecution(db, id, 'executed', result);
      return { ok: true, http_status: res.status, body };
    }
    recordExecution(db, id, 'failed', result);
    return { ok: false, http_status: res.status, body };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    recordExecution(db, id, 'failed', { error, at: deps.now() });
    return { ok: false, error };
  }
}
