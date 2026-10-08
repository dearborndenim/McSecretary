import type Database from 'better-sqlite3';
import type { TrustRow } from '../spine/types.js';
import type { ReviewProposalRow, ReviewRunRow, ReviewTrustRow } from '../spine/agent-review.js';

/*
 * The three reads behind the monthly agent review (src/spine/agent-review.ts).
 * They are deliberately broad; computeAgentReview applies the exact window.
 */

/** Agents that file into the spine but are not launchd business agents. */
export const SYSTEM_AGENTS: ReadonlyArray<string> = ['mcsecretary'];

/**
 * The one "is a business agent" predicate every review read uses: not a staff
 * member (staff filings carry agent = users.id, staff access Build 2) and not
 * McSecretary's own intake. Literal SQL, no input interpolated.
 */
const BUSINESS_AGENT_SQL = `agent NOT IN (SELECT id FROM users) AND agent NOT IN (${SYSTEM_AGENTS.map((a) => `'${a}'`).join(', ')})`;

/** Business-agent proposals created since `sinceIso`. */
export function listReviewProposals(db: Database.Database, sinceIso: string): ReviewProposalRow[] {
  return db.prepare(`
    SELECT agent, action_type, status, created_at, decided_at, telegram_message_id
    FROM proposals
    WHERE created_at >= ? AND ${BUSINESS_AGENT_SQL}
  `).all(sinceIso) as ReviewProposalRow[];
}

/**
 * Business-agent runs that may have started since `sinceIso`. `started_at` is
 * whatever Date.parse accepted at the route (offsets, date-only…), so the text
 * filter is a day wider than the window and any value not in YYYY-MM-DD form is
 * passed through; computeAgentReview applies the exact window numerically.
 */
export function listReviewRuns(db: Database.Database, sinceIso: string): ReviewRunRow[] {
  const wide = new Date(Date.parse(sinceIso) - 24 * 60 * 60 * 1000).toISOString();
  return db.prepare(`
    SELECT agent, outcome, started_at, notes, cost_usd
    FROM agent_run_index
    WHERE (started_at >= ? OR started_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
      AND ${BUSINESS_AGENT_SQL}
  `).all(wide) as ReviewRunRow[];
}

/** Every business-agent trust-ledger row: PROMOTE? counts lifetime approvals, not the window's. */
export function listReviewTrust(db: Database.Database): ReviewTrustRow[] {
  return db.prepare(`
    SELECT agent, action_type, level, approved_as_proposed, approved_with_edit, rejected
    FROM trust_ledger
    WHERE ${BUSINESS_AGENT_SQL}
  `).all() as ReviewTrustRow[];
}

/** Every business-agent trust-ledger row in full, for the staff UI's agents page. */
export function listBusinessTrustRows(db: Database.Database): TrustRow[] {
  return db.prepare(`
    SELECT * FROM trust_ledger WHERE ${BUSINESS_AGENT_SQL} ORDER BY agent, brand_id, action_type
  `).all() as TrustRow[];
}
