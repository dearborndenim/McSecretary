/**
 * Syncs dev requests between McSecretary and the Foreman's nightly plan.
 *
 * - formatApprovedRequestsForPlan: exports approved requests as markdown for NIGHTLY_PLAN.md
 * - formatPendingRequestsForBriefing: formats pending requests for the admin's morning briefing
 */

import type Database from 'better-sqlite3';
import { getApprovedDevRequests, getPendingDevRequests } from '../db/request-queries.js';
import { getUserById } from '../db/user-queries.js';

/**
 * Format approved dev requests as a "Team Requests" section for the Foreman's nightly plan.
 * Returns empty string if no approved requests exist.
 */
export function formatApprovedRequestsForPlan(db: Database.Database): string {
  const approved = getApprovedDevRequests(db);
  if (approved.length === 0) return '';

  return approved
    .map((r) => {
      const submitter = getUserById(db, r.user_id);
      const desc = r.refined_description ?? r.description;
      return `### Team Request #${r.id}: ${desc}\n**Submitted by:** ${submitter?.name ?? 'unknown'}\n**Project:** ${r.project ?? 'unspecified'}`;
    })
    .join('\n\n');
}

/**
 * Format pending dev requests for inclusion in the admin's morning briefing.
 * Returns undefined if no pending requests exist.
 */
export function formatPendingRequestsForBriefing(db: Database.Database): string | undefined {
  const pending = getPendingDevRequests(db);
  if (pending.length === 0) return undefined;

  return pending
    .map((r) => {
      const submitter = getUserById(db, r.user_id);
      return `- #${r.id} from ${submitter?.name ?? 'unknown'}${r.project ? ` (${r.project})` : ''}: ${r.description}`;
    })
    .join('\n');
}
