/**
 * The built-in `feedback` hand (agentic design workflow spec 2026-10-15 §4.1,
 * build C1): the one channel through which Sourcing, Costing, the Pattern
 * Maker, the Technical Designer and Robert's wall address the Designer.
 *
 * Like `notes`, `email` and `graph` it makes no HTTP call. Executing a
 * `design_feedback` proposal appends one row `{...body, received_at,
 * proposal_id}` to the feedback store,
 *
 *   <FEEDBACK_DIR>/<to_agent>/feedback/<brand>/<prompt>.json   (a JSON array)
 *
 * under a lock file, through a temp file + rename, and at most once per
 * proposal id (a re-execution of the same proposal appends nothing). The store
 * lives on McSecretary's volume (`FEEDBACK_DIR`, default `inputs/` beside the
 * SQLite file), because McSecretary runs on Railway and cannot write the Mac
 * mini's `~/.foreman/inputs`; the addressed agent reads its file back through
 * the read-only hand proxy (`GET /spine/hands/feedback/<to_agent>/<prompt>?brand=`,
 * i.e. `agent-kit hand-get --hand feedback`), which records it in the run like
 * any other hand read.
 *
 * A brand may register its own `feedback` hand in config to override this.
 */

import fs from 'node:fs';
import path from 'node:path';
import { isPlainObject } from './json-object.js';

export const FEEDBACK_HAND = 'feedback';
export const FEEDBACK_PATH = '/feedback';
/** The only action type the built-in `feedback` hand executes. */
export const FEEDBACK_ACTION_TYPE = 'design_feedback';

/** Agents that have a feedback store. The Designer is the only one in the spec. */
export const FEEDBACK_TO_AGENTS: ReadonlyArray<string> = Object.freeze(['designer']);
export const FEEDBACK_FROM: ReadonlyArray<string> = Object.freeze([
  'costing', 'sourcing', 'pattern-maker', 'technical-designer', 'wall',
]);
export const FEEDBACK_KINDS: ReadonlyArray<string> = Object.freeze([
  'cost_out_of_band', 'fabric_no_match', 'fabric_alternative', 'needs_procedure', 'critic_defect', 'rejected', 'note',
]);
export const FEEDBACK_SEVERITIES: ReadonlyArray<string> = Object.freeze(['block', 'revise', 'info']);

/** Same cap as a note's `notify`. */
export const FEEDBACK_SUGGESTION_MAX = 600;
/** `detail` is structured and kind-specific; this keeps one row (and the store) bounded. */
export const FEEDBACK_DETAIL_MAX_BYTES = 8192;

const BRAND_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** design-module's prompt and collection slugs (`safe_prompt_slug`): lowercase, digits, hyphens. */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,127}$/;

const BODY_KEYS = new Set([
  'to_agent', 'brand', 'prompt', 'collection', 'revision', 'product_index',
  'from', 'kind', 'severity', 'detail', 'suggestion',
]);

export interface FeedbackBody {
  to_agent: string;
  brand: string;
  prompt: string;
  collection: string;
  revision: number;
  product_index: number;
  from: string;
  kind: string;
  severity: string;
  detail: Record<string, unknown>;
  suggestion?: string;
}

export interface FeedbackRow extends FeedbackBody {
  received_at: string;
  proposal_id: number;
}

export interface FeedbackAppendResult {
  ok: true;
  /** Rows in the store file after this call. */
  rows: number;
  /** The store file, relative to FEEDBACK_DIR. */
  path: string;
  /** False when this proposal's row was already in the file (a re-execution). */
  appended: boolean;
  notify: string;
}

function oneOf(v: unknown, allowed: ReadonlyArray<string>, field: string): string | null {
  return typeof v === 'string' && allowed.includes(v) ? null : `${field} must be one of ${allowed.join('|')}`;
}

/**
 * Check a `design_feedback` action payload. `brandId` is the proposal's own
 * brand: the body's `brand` must match it, so an agent can only write the
 * feedback store of the brand it filed for. Unknown body keys are refused so
 * a typo never lands silently in the Designer's store.
 */
export function validateFeedbackPayload(
  p: { method: unknown; path: unknown; body: Record<string, unknown> },
  brandId: string,
): { ok: true; body: FeedbackBody } | { ok: false; error: string } {
  const fail = (error: string) => ({ ok: false as const, error });
  if (p.method !== 'POST') return fail(`action_payload.method must be POST for hand '${FEEDBACK_HAND}'`);
  if (p.path !== FEEDBACK_PATH) return fail(`action_payload.path must be '${FEEDBACK_PATH}' for hand '${FEEDBACK_HAND}'`);
  const b = p.body;
  const unknown = Object.keys(b).find((k) => !BODY_KEYS.has(k));
  if (unknown !== undefined) return fail(`action_payload.body.${unknown.slice(0, 64)} is not a feedback field`);
  const bad = oneOf(b.to_agent, FEEDBACK_TO_AGENTS, 'action_payload.body.to_agent')
    ?? oneOf(b.from, FEEDBACK_FROM, 'action_payload.body.from')
    ?? oneOf(b.kind, FEEDBACK_KINDS, 'action_payload.body.kind')
    ?? oneOf(b.severity, FEEDBACK_SEVERITIES, 'action_payload.body.severity');
  if (bad) return fail(bad);
  if (typeof b.brand !== 'string' || !BRAND_RE.test(b.brand)) return fail('action_payload.body.brand must be a lowercase slug');
  if (b.brand !== brandId) return fail('action_payload.body.brand must equal the proposal brand_id');
  if (typeof b.prompt !== 'string' || !SLUG_RE.test(b.prompt)) return fail('action_payload.body.prompt must be a prompt slug');
  if (typeof b.collection !== 'string' || !SLUG_RE.test(b.collection)) return fail('action_payload.body.collection must be a collection slug');
  if (!Number.isInteger(b.revision) || (b.revision as number) < 1) return fail('action_payload.body.revision must be an integer >= 1');
  if (!Number.isInteger(b.product_index) || (b.product_index as number) < 0) return fail('action_payload.body.product_index must be an integer >= 0');
  if (!isPlainObject(b.detail)) return fail('action_payload.body.detail must be an object');
  if (Buffer.byteLength(JSON.stringify(b.detail), 'utf8') > FEEDBACK_DETAIL_MAX_BYTES) {
    return fail(`action_payload.body.detail must be at most ${FEEDBACK_DETAIL_MAX_BYTES} bytes of JSON`);
  }
  if (b.suggestion !== undefined && (typeof b.suggestion !== 'string' || b.suggestion.length > FEEDBACK_SUGGESTION_MAX)) {
    return fail(`action_payload.body.suggestion must be a string of at most ${FEEDBACK_SUGGESTION_MAX} chars`);
  }
  return { ok: true, body: b as unknown as FeedbackBody };
}

/** The store file for one (agent, brand, prompt), relative to the store root. Inputs are validated slugs. */
export function feedbackRelPath(toAgent: string, brand: string, prompt: string): string {
  return path.join(toAgent, 'feedback', brand, `${prompt}.json`);
}

/** Read a store file: [] when absent; throws on a file that is not a JSON array (never clobbered). */
function readRows(file: string): FeedbackRow[] {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error(`Feedback store ${path.basename(file)} is not a JSON array`);
  return parsed as FeedbackRow[];
}

/** Rows for one (agent, brand, prompt); [] when nothing was filed yet. Slugs must be pre-validated. */
export function readFeedbackRows(root: string, toAgent: string, brand: string, prompt: string): FeedbackRow[] {
  return readRows(path.join(root, feedbackRelPath(toAgent, brand, prompt)));
}

/** A lock older than this was left by a crash (an append takes milliseconds). */
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 5_000;
const LOCK_POLL_MS = 25;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Take `<file>.lock` with O_EXCL; break it when stale; give up after LOCK_WAIT_MS. */
function withLock<T>(file: string, fn: () => T): T {
  const lock = `${file}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lock, 'wx'));
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) { fs.rmSync(lock, { force: true }); continue; }
      } catch { continue; /* released between open and stat */ }
      if (Date.now() > deadline) throw new Error(`Feedback store ${path.basename(file)} is locked`);
      sleepSync(LOCK_POLL_MS);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

/**
 * Append one row for `proposalId` to its store file and return the row count.
 * Idempotent per proposal id; the write is a temp file + rename under the
 * file's lock, so a reader never sees a half-written array and two appends
 * never lose each other's row.
 */
export function appendFeedbackRow(
  root: string,
  body: FeedbackBody,
  proposalId: number,
  nowIso: string,
): FeedbackAppendResult {
  const rel = feedbackRelPath(body.to_agent, body.brand, body.prompt);
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return withLock(file, () => {
    const rows = readRows(file);
    const notify = `Feedback to ${body.to_agent} from ${body.from}: ${body.kind} (${body.severity}) on ${body.prompt} ${body.collection}#${body.product_index}.`;
    if (rows.some((r) => r.proposal_id === proposalId)) {
      return { ok: true as const, rows: rows.length, path: rel, appended: false, notify };
    }
    rows.push({ ...body, received_at: nowIso, proposal_id: proposalId });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tmp, `${JSON.stringify(rows, null, 1)}\n`);
      fs.renameSync(tmp, file);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    return { ok: true as const, rows: rows.length, path: rel, appended: true, notify };
  });
}

/** Top-level keys a `design_feedback_executed` event carries straight from the body. */
export const FEEDBACK_EVENT_KEYS = [
  'to_agent', 'brand', 'prompt', 'collection', 'revision', 'severity', 'kind', 'product_index', 'from',
] as const;
