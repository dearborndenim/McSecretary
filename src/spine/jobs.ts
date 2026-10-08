import type Database from 'better-sqlite3';
import { listStaleEvents } from '../db/event-queries.js';
import { listFailedRunsSince } from '../db/run-index-queries.js';
import { trustSummarySince } from '../db/trust-queries.js';
import { listReviewProposals, listReviewRuns, listReviewTrust } from '../db/review-queries.js';
import { computeAgentReview, formatAgentReview } from './agent-review.js';
import { expireAndNotify } from './decision-events.js';
import type { ProposalRow } from './types.js';

const LIST_CAP = 10;

/**
 * 5 AM sweep: expire stale proposals, and build a short health report of
 * expired proposals, undrained events > 7d, and failed runs in the last 24h.
 * Returns null when there is nothing to report (no message is sent).
 * `onExpired` gets the rows this sweep expired (staff requester notices).
 */
export function runExpirySweep(
  db: Database.Database, nowIso: string, onExpired?: (rows: ProposalRow[]) => void,
): string | null {
  const expired = expireAndNotify(db, nowIso);
  if (onExpired && expired.length > 0) {
    try { onExpired(expired); } catch (err) { console.error('spine: expiry notice failed', err); }
  }
  const stale = listStaleEvents(db, 7, nowIso);
  const since = new Date(new Date(nowIso).getTime() - 86_400_000).toISOString();
  const failed = listFailedRunsSince(db, since);
  if (expired.length === 0 && stale.length === 0 && failed.length === 0) return null;

  const lines: string[] = ['Spine health'];
  if (expired.length) {
    lines.push(`Expired ${expired.length} proposal${expired.length === 1 ? '' : 's'} unanswered:`);
    for (const p of expired.slice(0, LIST_CAP)) lines.push(`  #${p.id} ${p.agent} ${p.action_type}`);
    if (expired.length > LIST_CAP) lines.push(`  …and ${expired.length - LIST_CAP} more`);
  }
  if (stale.length) lines.push(`${stale.length} event${stale.length === 1 ? '' : 's'} undrained > 7d (oldest: ${stale[0]!.event_type} from ${stale[0]!.source_hand})`);
  if (failed.length) {
    lines.push(`${failed.length} failed run${failed.length === 1 ? '' : 's'} in 24h:`);
    for (const r of failed.slice(0, LIST_CAP)) lines.push(`  ${r.agent} ${r.run_id} ${r.outcome}${r.notes ? ` — ${r.notes}` : ''}`);
    if (failed.length > LIST_CAP) lines.push(`  …and ${failed.length - LIST_CAP} more`);
  }
  return lines.join('\n');
}

/** Monthly trust summary for Robert (spec §4.4: promotion is his call). */
export function buildTrustMonthlySummary(db: Database.Database, sinceIso: string): string | null {
  const rows = trustSummarySince(db, sinceIso);
  if (rows.length === 0) return null;
  const byAgent = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byAgent.get(r.agent) ?? [];
    list.push(r);
    byAgent.set(r.agent, list);
  }
  const lines: string[] = [`Trust summary since ${sinceIso.slice(0, 10)}`];
  for (const [agent, list] of byAgent) {
    lines.push(agent);
    for (const r of list) {
      lines.push(`  ${r.action_type} L${r.level} · ${r.approved_as_proposed} as proposed · ${r.approved_with_edit} edited · ${r.rejected} rejected`);
    }
  }
  lines.push('Reply "promote <agent> <action> <level>" to change a level.');
  return lines.join('\n');
}

/** Default and maximum window of the agent review, in days (spec §4). */
export const AGENT_REVIEW_DEFAULT_DAYS = 30;
export const AGENT_REVIEW_MAX_DAYS = 90;

/** Start of the trailing `days` days before `nowIso` — the `/agentreview [days]` window. */
export function trailingDaysSince(nowIso: string, days: number): string {
  return new Date(Date.parse(nowIso) - days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * The agent review message for [sinceIso, nowIso]. The monthly job passes the
 * same `since` as the trust summary (one calendar month back); `/agentreview`
 * passes `trailingDaysSince`.
 */
export function buildAgentReview(db: Database.Database, sinceIso: string, nowIso: string): string {
  return formatAgentReview(computeAgentReview({
    proposals: listReviewProposals(db, sinceIso),
    runs: listReviewRuns(db, sinceIso),
    trust: listReviewTrust(db),
    sinceIso,
    nowIso,
  }));
}
