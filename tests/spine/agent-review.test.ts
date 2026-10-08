import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import { listReviewProposals, listReviewRuns, listReviewTrust } from '../../src/db/review-queries.js';
import {
  computeAgentReview, formatAgentReview, MAX_MESSAGE_CHARS,
  type AgentStats, type AgentReview, type ReviewProposalRow, type ReviewRunRow, type ReviewTrustRow,
} from '../../src/spine/agent-review.js';

const NOW = '2026-10-08T12:00:00.000Z';
const SINCE = '2026-09-08T12:00:00.000Z';
const IN = '2026-09-20T15:00:00.000Z';
const DECIDED = '2026-09-21T15:00:00.000Z';

function cards(agent: string, action_type: string, n: number, status: string, decided = false): ReviewProposalRow[] {
  return Array.from({ length: n }, () => ({
    agent, action_type, status, created_at: IN, decided_at: decided ? DECIDED : null, telegram_message_id: 1,
  }));
}
function autos(agent: string, action_type: string, n: number): ReviewProposalRow[] {
  return Array.from({ length: n }, () => ({
    agent, action_type, status: 'executed', created_at: IN, decided_at: null, telegram_message_id: null,
  }));
}
function runs(agent: string, n: number, outcome: string, cost_usd: number | null, notes = '', started_at = IN): ReviewRunRow[] {
  return Array.from({ length: n }, () => ({ agent, outcome, started_at, notes, cost_usd }));
}
function trust(agent: string, action_type: string, level: number, a: number, e: number, r: number): ReviewTrustRow {
  return { agent, action_type, level, approved_as_proposed: a, approved_with_edit: e, rejected: r };
}

const PURCHASING_NOTE = 'hand-get kanban-purchaser /api/integration/materials failed: 502 Bad Gateway from the kanban hand on every page of materials';

const proposals: ReviewProposalRow[] = [
  // designer: every card decided (rejection-free), 22 cards → NOISY, not IGNORED
  ...cards('designer', 'fabric_intent', 22, 'executed', true),
  // design-artist: 6/6 decided
  ...cards('design-artist', 'design_concept', 6, 'approved', true),
  // marketing-creative: 3/4 decided, 8 silent auto-executions
  ...cards('marketing-creative', 'creative_promote', 3, 'executed', true),
  ...cards('marketing-creative', 'creative_promote', 1, 'pending'),
  ...autos('marketing-creative', 'creative_pause', 8),
  // sourcing: 12 cards, 2 rejected, 9 expired → IGNORED by expired share; rfq_send rejected twice
  ...cards('sourcing', 'rfq_send', 2, 'rejected', true),
  ...cards('sourcing', 'rfq_send', 9, 'expired'),
  ...cards('sourcing', 'rfq_send', 1, 'pending'),
  // production-planner: 10 cards, 0 decided, 4 expired (0.4) → IGNORED by the 10-and-none branch
  ...cards('production-planner', 'po_draft', 4, 'expired'),
  ...cards('production-planner', 'po_draft', 6, 'pending'),
  // costing: 20 auto, 0 cards → SILENT ONLY
  ...autos('costing', 'cost_update', 20),
  // finance: 5 failed auto-executions ≥ its 2 successful ones → BROKEN with no failed runs
  ...autos('finance', 'journal_entry', 2),
  ...Array.from({ length: 5 }, () => ({ agent: 'finance', action_type: 'journal_entry', status: 'failed', created_at: IN, decided_at: null, telegram_message_id: null })),
  // one failed auto for marketing-creative: under 5, not BROKEN
  { agent: 'marketing-creative', action_type: 'creative_pause', status: 'failed', created_at: IN, decided_at: null, telegram_message_id: null },
  // smoke: 2 cards, both expired — under IGNORED_MIN_CARDS, so not IGNORED
  ...cards('smoke', 'smoke_note', 2, 'expired'),
  // outside the window: must count nowhere
  { agent: 'sourcing', action_type: 'rfq_send', status: 'expired', created_at: '2026-08-20T12:00:00.000Z', decided_at: null, telegram_message_id: 9 },
  { agent: 'designer', action_type: 'fabric_intent', status: 'rejected', created_at: '2026-08-20T12:00:00.000Z', decided_at: '2026-08-21T12:00:00.000Z', telegram_message_id: 9 },
  // created before the window, decided inside it: not counted, so decided never exceeds cards
  { agent: 'design-artist', action_type: 'design_concept', status: 'approved', created_at: '2026-09-01T12:00:00.000Z', decided_at: '2026-09-10T12:00:00.000Z', telegram_message_id: 9 },
];

const runRows: ReviewRunRow[] = [
  ...runs('designer', 3, 'ok', 3),
  ...runs('design-artist', 2, 'ok', 2.5),
  ...runs('sourcing', 2, 'ok', 15),
  ...runs('production-planner', 1, 'ok', 8),
  // purchasing: 3 hand errors + 1 run stuck `running` for 2 days = 4/6 failed → BROKEN
  ...runs('purchasing', 3, 'hand_error', 1, PURCHASING_NOTE),
  ...runs('purchasing', 1, 'running', null, '', '2026-10-06T12:00:00.000Z'),
  ...runs('purchasing', 2, 'ok', 1),
  // merchandiser: 9/10 nothing → IDLE; no cost reported
  ...runs('merchandiser', 9, 'nothing_to_do', null),
  ...runs('merchandiser', 1, 'ok', null),
  // smoke: 7 nothing + a run started 1 h ago still `running` (not failed) = 7/10 → not IDLE
  ...runs('smoke', 7, 'nothing_to_do', null),
  ...runs('smoke', 2, 'ok', null),
  ...runs('smoke', 1, 'running', null, '', '2026-10-08T11:00:00.000Z'),
  // costing: $10 over 20 auto-runs and no decisions → "$0.50 per auto-run"
  ...runs('costing', 2, 'ok', 5),
  // trend-scout: 10/10 nothing, one stamped with an offset (11:30Z, inside the window) → IDLE
  ...runs('trend-scout', 9, 'nothing_to_do', null),
  ...runs('trend-scout', 1, 'nothing_to_do', null, '', '2026-10-08T06:30:00-05:00'),
  // outside the window: before since by text, by date-only (midnight UTC) and by offset (11:00Z)
  ...runs('smoke', 1, 'hand_error', 100, 'old', '2026-09-01T12:00:00.000Z'),
  ...runs('smoke', 1, 'hand_error', 100, 'old', '2026-09-08'),
  ...runs('smoke', 1, 'hand_error', 100, 'old', '2026-09-08T13:00:00+02:00'),
];

const trustRows: ReviewTrustRow[] = [
  trust('designer', 'fabric_intent', 1, 22, 0, 0),
  trust('designer', 'fabric_intent', 1, 3, 0, 0), // second brand; summed
  trust('marketing-creative', 'creative_promote', 1, 6, 0, 0),
  trust('marketing-creative', 'creative_pause', 3, 30, 0, 0), // already promoted
  trust('sourcing', 'rfq_send', 1, 1, 0, 2), // rejections
  trust('design-artist', 'design_concept', 1, 6, 1, 0), // an edit
  trust('design-artist', 'design_concept', 1, 5, 0, 0), // other brand clean, but the pair has an edit
  trust('production-planner', 'po_draft', 1, 4, 0, 0), // under 5
  trust('designer', 'fabric_pick', 1, 9, 0, 0), // pinned human gate
  trust('costing', 'cost_update', 2, 20, 0, 0), // level 2
];

const review = computeAgentReview({ proposals, runs: runRows, trust: trustRows, sinceIso: SINCE, nowIso: NOW });
const agent = (name: string): AgentStats => review.agents.find((s) => s.agent === name)!;

describe('computeAgentReview', () => {
  it('fires every flag exactly where intended', () => {
    const flags = Object.fromEntries(review.agents.map((s) => [s.agent, s.flags]));
    expect(flags).toEqual({
      'costing': ['SILENT ONLY'],
      'design-artist': [],
      'designer': ['NOISY', 'PROMOTE?'],
      'finance': ['BROKEN'],
      'marketing-creative': ['PROMOTE?'],
      'merchandiser': ['IDLE'],
      'production-planner': ['IGNORED'],
      'purchasing': ['BROKEN'],
      'smoke': [],
      'sourcing': ['IGNORED'],
      'trend-scout': ['IDLE'],
    });
  });

  it('counts cards, decisions, expiries and auto-executions inside the window only', () => {
    expect(agent('designer')).toMatchObject({ cards: 22, decided: 22, ignored: 0, auto: 0 });
    expect(agent('design-artist')).toMatchObject({ cards: 6, decided: 6 });
    expect(agent('marketing-creative')).toMatchObject({ cards: 4, decided: 3, auto: 8, autoFailed: 1 });
    expect(agent('finance')).toMatchObject({ runs: 0, auto: 2, autoFailed: 5 });
    expect(agent('smoke')).toMatchObject({ cards: 2, ignored: 2 });
    for (const s of review.agents) expect(s.decided).toBeLessThanOrEqual(s.cards);
    expect(agent('sourcing')).toMatchObject({ cards: 12, decided: 2, ignored: 9 });
    expect(agent('production-planner')).toMatchObject({ cards: 10, decided: 0, ignored: 4 });
    expect(agent('costing')).toMatchObject({ cards: 0, auto: 20 });
    expect(agent('sourcing').rejectedTypes).toEqual([{ action_type: 'rfq_send', count: 2 }]);
  });

  it('counts a run stuck in `running` over 24 h as failed, a fresh one as neither', () => {
    expect(agent('purchasing')).toMatchObject({ runs: 6, ok: 2, failed: 4 });
    expect(agent('smoke')).toMatchObject({ runs: 10, ok: 2, nothing: 7, failed: 0 });
    expect(agent('trend-scout')).toMatchObject({ runs: 10, nothing: 10 });
    expect(agent('purchasing').brokenNote).toBe(PURCHASING_NOTE.slice(0, 80));
  });

  it('lists promotion candidates summed over brands, skipping pinned, edited, rejected and promoted pairs', () => {
    expect(review.promote).toEqual([
      { agent: 'designer', action_type: 'fabric_intent', approved: 25 },
      { agent: 'marketing-creative', action_type: 'creative_promote', approved: 6 },
    ]);
  });

  it('computes cost and $/decision, n/a when no run reported cost', () => {
    expect(review.totalCostUsd).toBeCloseTo(67, 10); // 30 + 9 + 5 + 8 + 5 + 10
    expect(agent('sourcing').costUsd).toBe(30);
    expect(agent('sourcing').costPerDecision).toBe(15);
    expect(agent('designer').costPerDecision).toBeCloseTo(9 / 22, 10);
    expect(agent('production-planner').costPerDecision).toBe(Infinity);
    expect(agent('merchandiser').costUsd).toBeNull();
    expect(agent('merchandiser').costPerDecision).toBeNull();
    const none = computeAgentReview({ proposals: [], runs: runs('smoke', 2, 'ok', null), trust: [], sinceIso: SINCE, nowIso: NOW });
    expect(none.totalCostUsd).toBeNull();
    expect(formatAgentReview(none)).toContain('Cost: n/a');
  });
});

describe('formatAgentReview', () => {
  it('renders one line per non-empty section in the spec order', () => {
    const text = formatAgentReview(review);
    expect(text.split('\n')).toEqual([
      'Agent review — Sep 8 → Oct 8',
      'Decided on: designer 22/22 cards · design-artist 6/6 · marketing-creative 3/4, 8 auto',
      'Ignored: sourcing 12 cards, 2 decided · production-planner 10 cards, 0 decided',
      'Noisy: designer 22 cards',
      `Broken: finance 5 auto failed · purchasing 4/6 runs failed — "${PURCHASING_NOTE.slice(0, 80)}"`,
      'Idle: trend-scout 10/10 runs nothing or failed · merchandiser 9/10 runs nothing or failed',
      'Silent only: costing 20 auto, 0 cards',
      'Rejected: sourcing/rfq_send 2 rejections',
      'Promote?: designer/fabric_intent (25 approved, 0 edits) · marketing-creative/creative_promote (6/0)',
      'Cost: $67 (sourcing $30 · costing $10 · designer $9) — $/decision: sourcing $15, costing $0.50 per auto-run, designer $0.41',
      'Park an agent: launchctl unload on the Mac mini (agents/README.md → Fleet review).',
    ]);
  });

  it('omits empty sections', () => {
    const quiet = computeAgentReview({
      proposals: cards('designer', 'fabric_intent', 3, 'approved', true), runs: runs('designer', 1, 'ok', 2), trust: [], sinceIso: SINCE, nowIso: NOW,
    });
    expect(formatAgentReview(quiet).split('\n')).toEqual([
      'Agent review — Sep 8 → Oct 8',
      'Decided on: designer 3/3 cards',
      'Cost: $2 (designer $2) — $/decision: designer $0.67',
    ]);
    const idleSpend = computeAgentReview({ proposals: [], runs: runs('smoke', 1, 'nothing_to_do', 3), trust: [], sinceIso: SINCE, nowIso: NOW });
    expect(formatAgentReview(idleSpend)).toContain('$/decision: smoke no decisions');
  });

  it('stays under 1,500 chars with 15 agents carrying every flag, capping names with +N', () => {
    const many: AgentStats[] = Array.from({ length: 15 }, (_, i) => ({
      agent: `marketing-creative-${String(i).padStart(2, '0')}`,
      runs: 40, ok: 0, nothing: 10, failed: 30, cards: 150 + i, decided: i % 2, ignored: 140, auto: 300,
      rejectedTypes: [{ action_type: 'creative_promote_long_name', count: 12 }],
      costUsd: 1234.5 + i, costPerDecision: i % 2 ? 1234.5 + i : Infinity,
      brokenNote: PURCHASING_NOTE.slice(0, 80),
      flags: ['IGNORED', 'IDLE', 'BROKEN', 'NOISY', 'PROMOTE?', 'SILENT ONLY'],
    }));
    const big: AgentReview = {
      since: SINCE, until: NOW, agents: many, totalCostUsd: 18_570,
      promote: many.map((s) => ({ agent: s.agent, action_type: 'creative_promote_long_name', approved: 99 })),
    };
    const text = formatAgentReview(big);
    expect(text.length).toBeLessThan(MAX_MESSAGE_CHARS);
    expect(text).toMatch(/\+\d+$/m);
    for (const line of text.split('\n')) {
      if (line.startsWith('Cost') || line.startsWith('Park') || line.startsWith('Agent review')) continue;
      expect(line.split(' · ').length).toBeLessThanOrEqual(5);
    }
  });
});

describe('review queries', () => {
  it('keep staff users and the mcsecretary system agent out of all three reads', () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    db.prepare("INSERT INTO users (id, name, email) VALUES ('olivier', 'Olivier', 'olivier@dearborndenim.com')").run();
    const insP = db.prepare(`INSERT INTO proposals (agent, brand_id, action_type, action_payload, payload_hash, reason, expires_at, status, created_at, telegram_message_id)
      VALUES (?, 'dearborn-denim', ?, '{}', 'h', 'r', '2026-10-30T00:00:00.000Z', 'pending', '2026-10-01T00:00:00.000Z', 1)`);
    const insT = db.prepare("INSERT INTO trust_ledger (agent, brand_id, action_type, level, approved_as_proposed) VALUES (?, 'dearborn-denim', ?, 1, 9)");
    const insR = db.prepare(`INSERT INTO agent_run_index (run_id, agent, brand_id, skill_commit, model, started_at, outcome)
      VALUES (?, ?, 'dearborn-denim', 'a', 'm', '2026-10-01T00:00:00.000Z', 'ok')`);
    for (const [agent, type] of [['olivier', 'store_transfer'], ['mcsecretary', 'rfq_reply_unparsed'], ['sourcing', 'rfq_send']] as const) {
      insP.run(agent, type); insT.run(agent, type); insR.run(`r-${agent}`, agent);
    }
    expect(listReviewProposals(db, SINCE).map((r) => r.agent)).toEqual(['sourcing']);
    expect(listReviewRuns(db, SINCE).map((r) => r.agent)).toEqual(['sourcing']);
    expect(listReviewTrust(db).map((r) => r.agent)).toEqual(['sourcing']);
  });
});
