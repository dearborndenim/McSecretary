import type Database from 'better-sqlite3';
import { expireProposals } from '../db/proposal-queries.js';
import { listStaleEvents } from '../db/event-queries.js';
import { listFailedRunsSince } from '../db/run-index-queries.js';
import { trustSummarySince } from '../db/trust-queries.js';

/**
 * 5 AM sweep: expire stale proposals, and build a short health report of
 * expired proposals, undrained events > 7d, and failed runs in the last 24h.
 * Returns null when there is nothing to report (no message is sent).
 */
export function runExpirySweep(db: Database.Database, nowIso: string): string | null {
  const expired = expireProposals(db, nowIso);
  const stale = listStaleEvents(db, 7, nowIso);
  const since = new Date(new Date(nowIso).getTime() - 86_400_000).toISOString();
  const failed = listFailedRunsSince(db, since);
  if (expired.length === 0 && stale.length === 0 && failed.length === 0) return null;

  const lines: string[] = ['Spine health'];
  if (expired.length) {
    lines.push(`Expired ${expired.length} proposal${expired.length === 1 ? '' : 's'} unanswered:`);
    for (const p of expired.slice(0, 10)) lines.push(`  #${p.id} ${p.agent} ${p.action_type}`);
  }
  if (stale.length) lines.push(`${stale.length} event${stale.length === 1 ? '' : 's'} undrained > 7d (oldest: ${stale[0]!.event_type} from ${stale[0]!.source_hand})`);
  if (failed.length) {
    lines.push(`${failed.length} failed run${failed.length === 1 ? '' : 's'} in 24h:`);
    for (const r of failed.slice(0, 10)) lines.push(`  ${r.agent} ${r.run_id} ${r.outcome}${r.notes ? ` — ${r.notes}` : ''}`);
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
