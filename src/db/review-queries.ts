import type Database from 'better-sqlite3';
import type { ReviewProposalRow, ReviewRunRow, ReviewTrustRow } from '../spine/agent-review.js';

/*
 * The three reads behind the monthly agent review (src/spine/agent-review.ts).
 * They are deliberately broad; computeAgentReview applies the exact window.
 */

/**
 * Proposals created or decided since `sinceIso`. Staff filings (agent = a
 * `users.id`, staff access Build 2) are people, not business agents, and are
 * left out.
 */
export function listReviewProposals(db: Database.Database, sinceIso: string): ReviewProposalRow[] {
  return db.prepare(`
    SELECT agent, action_type, status, created_at, decided_at, telegram_message_id
    FROM proposals
    WHERE (created_at >= ? OR decided_at >= ?)
      AND agent NOT IN (SELECT id FROM users)
  `).all(sinceIso, sinceIso) as ReviewProposalRow[];
}

/** Runs started since `sinceIso`. */
export function listReviewRuns(db: Database.Database, sinceIso: string): ReviewRunRow[] {
  return db.prepare(`
    SELECT agent, outcome, started_at, notes, cost_usd
    FROM agent_run_index
    WHERE started_at >= ?
  `).all(sinceIso) as ReviewRunRow[];
}

/** Every trust-ledger row: PROMOTE? counts lifetime approvals, not the window's. */
export function listReviewTrust(db: Database.Database): ReviewTrustRow[] {
  return db.prepare(`
    SELECT agent, action_type, level, approved_as_proposed, approved_with_edit, rejected
    FROM trust_ledger
  `).all() as ReviewTrustRow[];
}
