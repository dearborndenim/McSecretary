/**
 * Syncs dev requests between McSecretary and the Foreman's nightly plan.
 *
 * - formatApprovedRequestsForPlan: exports approved requests as markdown for NIGHTLY_PLAN.md
 * - formatPendingRequestsForBriefing: formats pending requests for the admin's morning briefing
 */

import type Database from 'better-sqlite3';
import {
  getApprovedDevRequests,
  getApprovedUnsyncedDevRequests,
  getPendingDevRequests,
  type DevRequest,
} from '../db/request-queries.js';
import { getUserById } from '../db/user-queries.js';

function formatRequests(db: Database.Database, rows: DevRequest[]): string {
  if (rows.length === 0) return '';
  return rows
    .map((r) => {
      const submitter = getUserById(db, r.user_id);
      const desc = r.refined_description ?? r.description;
      return `### Team Request #${r.id}: ${desc}\n**Submitted by:** ${submitter?.name ?? 'unknown'}\n**Project:** ${r.project ?? 'unspecified'}`;
    })
    .join('\n\n');
}

/**
 * Format approved dev requests as a "Team Requests" section for the Foreman's nightly plan.
 * Returns empty string if no approved requests exist.
 *
 * Pass onlyUnsynced=true when building the section to append to GitHub's NIGHTLY_PLAN.md —
 * already-synced requests have been pushed already and shouldn't be re-added.
 */
export function formatApprovedRequestsForPlan(
  db: Database.Database,
  onlyUnsynced: boolean = false,
): string {
  const rows = onlyUnsynced
    ? getApprovedUnsyncedDevRequests(db)
    : getApprovedDevRequests(db);
  return formatRequests(db, rows);
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
