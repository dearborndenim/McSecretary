import type Database from 'better-sqlite3';
import { decideProposal, expireProposals, getProposalById } from '../db/proposal-queries.js';
import { insertEvent } from '../db/event-queries.js';
import { copyScalarKeys, isPlainObject, safeJsonObject } from './json-object.js';
import type { ProposalRow } from './types.js';

/** Fixed top-level keys on a `*_rejected` / `*_expired` event payload that flattening must never overwrite. */
const DECISION_EVENT_FIXED_KEYS = new Set(['proposal_id', 'agent', 'action_type', 'hand', 'path', 'decided_by']);

/** Longer body strings (an email's `text`/`html`) are never copied onto the event. */
const BODY_STRING_CAP = 200;

/**
 * Best-effort: tell the filer its card was rejected or expired unanswered, by inserting
 * `<action_type>_rejected` / `<action_type>_expired` (not urgent). Opt-in is the only rule:
 * emitted only when the proposal's `evidence.decision_events` is exactly `true`, whatever the
 * hand, and a filer that sets it must drain those event types (otherwise they go stale in the
 * 5 AM health report). Payload: proposal_id, agent, action_type, hand, path, decided_by (null
 * on expiry), plus the top-level numbers, booleans and strings of at most 200 chars from
 * `action_payload.body` that do not collide with those. The insert runs in its own savepoint
 * and any error is logged and swallowed, so it never fails or rolls back the decision.
 */
function emitDecisionEvent(
  db: Database.Database,
  row: ProposalRow,
  outcome: 'rejected' | 'expired',
  decidedBy: string | null,
  nowIso: string,
): void {
  if (safeJsonObject(row.evidence).decision_events !== true) return;
  try {
    const payload: unknown = JSON.parse(row.action_payload);
    if (!isPlainObject(payload)) throw new Error('action_payload is not an object');
    const eventPayload: Record<string, unknown> = {
      proposal_id: row.id,
      agent: row.agent,
      action_type: row.action_type,
      hand: payload.hand ?? null,
      path: payload.path ?? null,
      decided_by: decidedBy,
    };
    copyScalarKeys(payload.body, eventPayload, DECISION_EVENT_FIXED_KEYS, BODY_STRING_CAP);
    // Nested transaction = savepoint: a failed insert rolls back only itself.
    db.transaction(() => insertEvent(db, {
      source_hand: 'spine',
      brand_id: row.brand_id,
      event_type: `${row.action_type}_${outcome}`,
      payload: eventPayload,
      urgent: false,
    }, nowIso))();
  } catch (err) {
    console.error(`spine: ${outcome}-event emit failed`, row.id, err);
  }
}

/**
 * Reject a pending proposal and, in the same transaction, emit its opt-in
 * `<action_type>_rejected` event. Returns what `decideProposal` returned: false
 * (and no event) when the row is missing or already decided.
 */
export function rejectProposal(db: Database.Database, id: number, decidedBy: string, nowIso: string): boolean {
  return db.transaction(() => {
    if (!decideProposal(db, id, 'rejected', decidedBy, nowIso)) return false;
    const row = getProposalById(db, id);
    if (row) emitDecisionEvent(db, row, 'rejected', decidedBy, nowIso);
    return true;
  })();
}

/**
 * Expire every pending proposal past its expiry and, in the same transaction,
 * emit each one's opt-in `<action_type>_expired` event. Returns the expired rows.
 */
export function expireAndNotify(db: Database.Database, nowIso: string): ProposalRow[] {
  return db.transaction(() => {
    const expired = expireProposals(db, nowIso);
    for (const p of expired) emitDecisionEvent(db, p, 'expired', null, nowIso);
    return expired;
  })();
}
