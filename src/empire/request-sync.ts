/**
 * Dev-request formatting for McSecretary's own surfaces.
 *
 * - formatPendingRequestsForBriefing: formats pending requests for the admin's morning briefing
 *
 * There is deliberately no GitHub export here: McSecretary is read-only against
 * GitHub (Robert, 2026-09-10) and never queues work for a build system.
 */

import type Database from 'better-sqlite3';
import { getPendingDevRequests } from '../db/request-queries.js';
import { getUserById } from '../db/user-queries.js';

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
