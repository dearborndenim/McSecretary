/**
 * `agent_actions` — the admin-only "What the agents did" briefing section.
 *
 * Covers:
 *  - the pure formatter (executed + failed + pending + runs; empty ⇒ null;
 *    evidence degradation; reason truncation)
 *  - the two new DB queries against an in-memory sqlite, including the
 *    24h window boundaries and the auto-execute (decided_at IS NULL) path
 *  - the loader's graceful-failure contract
 *  - section gating in buildBriefingPrompt + admin-only wiring in triage.ts
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import { listExecutedProposalsSince } from '../../src/db/proposal-queries.js';
import { listLatestRunsSince } from '../../src/db/run-index-queries.js';
import {
  formatAgentActionsSection,
  formatAdRef,
  loadAgentActionsData,
  truncate,
  REASON_CAP,
  type AgentActionsData,
} from '../../src/briefing/agent-actions.js';
import { buildBriefingPrompt } from '../../src/briefing/generator.js';
import {
  VALID_BRIEFING_SECTIONS,
  BRIEFING_SECTION_DESCRIPTIONS,
  isValidBriefingSection,
} from '../../src/briefing/sections.js';

const NOW = '2026-09-17T10:00:00.000Z';
const SINCE = '2026-09-16T10:00:00.000Z';

function emptyData(): AgentActionsData {
  return { since: SINCE, now: NOW, executed: [], pending: [], runs: [] };
}

// ---------------------------------------------------------------------------
// The pure formatter
// ---------------------------------------------------------------------------
describe('formatAgentActionsSection', () => {
  it('renders failures first, then executed grouped by agent and action type, pending, and run notes', () => {
    const data: AgentActionsData = {
      since: SINCE,
      now: NOW,
      executed: [
        {
          id: 40, agent: 'marketing-creative', action_type: 'creative_pause', status: 'executed',
          reason: 'Stock: 2+ sizes sold out',
          evidence: JSON.stringify({ ad_name: 'DD Fall Hook A', external_ad_id: '120330111' }),
          execution_result: '{"ok":true}', at: '2026-09-17T07:15:00.000Z',
        },
        {
          id: 43, agent: 'marketing-creative', action_type: 'creative_pause', status: 'executed',
          reason: 'Stock: 3 sizes sold out',
          evidence: JSON.stringify({ ad_name: 'DD Winter Tee', external_ad_id: '120330222' }),
          execution_result: '{"ok":true}', at: '2026-09-17T07:15:01.000Z',
        },
        {
          id: 44, agent: 'marketing-creative', action_type: 'creative_promote', status: 'executed',
          reason: 'ROAS 2.4x over 7 matured days',
          evidence: JSON.stringify({ ad_name: 'DD Fall Hook A', external_ad_id: '120330111' }),
          execution_result: '{"ok":true}', at: '2026-09-17T07:15:02.000Z',
        },
        {
          id: 46, agent: 'purchasing', action_type: 'po_draft', status: 'executed',
          reason: 'Vendor minimum reached for Carr Textile',
          evidence: '{}', execution_result: '{"ok":true}', at: '2026-09-17T08:00:00.000Z',
        },
        {
          id: 45, agent: 'marketing-creative', action_type: 'creative_cut', status: 'failed',
          reason: 'CPA 3x target for 14 straight days',
          evidence: JSON.stringify({ ad_name: 'DD Denim Jacket', external_ad_id: '120330333' }),
          execution_result: '{"ok":false,"error":"ad-manager unreachable","http_status":502}',
          at: '2026-09-17T07:16:00.000Z',
        },
      ],
      pending: [
        { id: 51, agent: 'marketing-manager', action_type: 'ad_spend_step', expires_at: '2026-09-19T10:00:00.000Z' },
        { id: 52, agent: 'marketing-manager', action_type: 'creative_request', expires_at: '2026-09-19T10:00:00.000Z' },
        { id: 53, agent: 'sourcing', action_type: 'rfq_send', expires_at: '2026-09-17T20:00:00.000Z' },
      ],
      runs: [
        {
          agent: 'marketing-creative', run_id: 'r-mc-1', outcome: 'ok', started_at: '2026-09-17T07:15:00.000Z',
          notes: 'Creative run 2026-09-17: 19 ads judged, 2 stock pauses, 1 stock resumes, 2 promotes, 0 cuts, 0 candidates, 10 holds. No batch this run: fewer than 3 PAUSED test ads.',
        },
        { agent: 'finance', run_id: 'r-fin-1', outcome: 'nothing_to_do', notes: '', started_at: '2026-09-17T06:00:00.000Z' },
      ],
    };

    const out = formatAgentActionsSection(data);
    expect(out).not.toBeNull();

    // Failures come before the executed block.
    expect(out!.indexOf('FAILED (1):')).toBeGreaterThan(-1);
    expect(out!.indexOf('FAILED (1):')).toBeLessThan(out!.indexOf('EXECUTED (4):'));
    expect(out!).toContain('- marketing-creative creative_cut #45 — CPA 3x target for 14 straight days (ad: DD Denim Jacket / 120330333) [ad-manager unreachable HTTP 502]');
    // The failed row is NOT double-counted in the executed block.
    expect(out!).not.toContain('creative_cut x1');

    // Grouped by agent (alphabetical), then action type (biggest group first).
    expect(out!).toContain('marketing-creative — 3');
    expect(out!).toContain('  creative_pause x2');
    expect(out!).toContain('  creative_promote x1');
    expect(out!).toContain('    - #40 Stock: 2+ sizes sold out (ad: DD Fall Hook A / 120330111)');
    expect(out!).toContain('purchasing — 1');
    expect(out!.indexOf('marketing-creative — 3')).toBeLessThan(out!.indexOf('purchasing — 1'));
    expect(out!.indexOf('  creative_pause x2')).toBeLessThan(out!.indexOf('  creative_promote x1'));

    // Pending, with the sub-24h expiry called out only on the row that has one.
    expect(out!).toContain('STILL WAITING ON YOU (3):');
    expect(out!).toContain('- marketing-manager — 2 pending: #51, #52');
    expect(out!).toContain('- sourcing — 1 pending: #53 (expiring within 24h: #53)');

    // Run notes verbatim.
    expect(out!).toContain('- marketing-creative (ok): Creative run 2026-09-17: 19 ads judged, 2 stock pauses, 1 stock resumes, 2 promotes, 0 cuts, 0 candidates, 10 holds. No batch this run: fewer than 3 PAUSED test ads.');
    expect(out!).toContain('- finance (nothing_to_do)');
    expect(out!).not.toContain('finance (nothing_to_do):'); // no trailing colon when notes are empty
  });

  it('returns null when nothing happened at all', () => {
    expect(formatAgentActionsSection(emptyData())).toBeNull();
  });

  it('returns a section when ONLY pending cards exist (nothing executed, no runs)', () => {
    const out = formatAgentActionsSection({
      ...emptyData(),
      pending: [{ id: 9, agent: 'sourcing', action_type: 'rfq_send', expires_at: '2026-09-25T00:00:00.000Z' }],
    });
    expect(out).toContain('STILL WAITING ON YOU (1):');
    expect(out).not.toContain('EXECUTED');
    expect(out).not.toContain('expiring within 24h');
  });

  it('degrades gracefully when evidence has no ad_name, only an id, or is malformed/absent', () => {
    expect(formatAdRef(JSON.stringify({ ad_name: 'A', external_ad_id: '1' }))).toBe(' (ad: A / 1)');
    expect(formatAdRef(JSON.stringify({ ad_name: 'A' }))).toBe(' (ad: A)');
    expect(formatAdRef(JSON.stringify({ external_ad_id: '1' }))).toBe(' (ad id: 1)');
    // Numbers are coerced — agents have filed external_ad_id both ways.
    expect(formatAdRef(JSON.stringify({ external_ad_id: 120330111 }))).toBe(' (ad id: 120330111)');
    expect(formatAdRef(JSON.stringify({ ad_name: '   ', external_ad_id: '' }))).toBe('');
    expect(formatAdRef('{}')).toBe('');
    expect(formatAdRef('not json at all')).toBe('');
    expect(formatAdRef('[1,2,3]')).toBe('');
    expect(formatAdRef(null)).toBe('');

    const out = formatAgentActionsSection({
      ...emptyData(),
      executed: [{
        id: 7, agent: 'marketing-creative', action_type: 'creative_resume', status: 'executed',
        reason: 'Back in stock', evidence: JSON.stringify({ external_ad_id: '120330999' }),
        execution_result: null, at: '2026-09-17T07:00:00.000Z',
      }],
    });
    expect(out).toContain('    - #7 Back in stock (ad id: 120330999)');
  });

  it('truncates a long reason to REASON_CAP chars including the ellipsis', () => {
    const long = 'x'.repeat(400);
    expect(truncate(long, REASON_CAP)).toHaveLength(REASON_CAP);
    expect(truncate(long, REASON_CAP).endsWith('…')).toBe(true);
    expect(truncate('short', REASON_CAP)).toBe('short');

    const out = formatAgentActionsSection({
      ...emptyData(),
      executed: [{
        id: 8, agent: 'finance', action_type: 'cash_floor_alert', status: 'executed',
        reason: `${long} TAIL`, evidence: '{}', execution_result: null, at: '2026-09-17T06:00:00.000Z',
      }],
    })!;
    const line = out.split('\n').find((l) => l.startsWith('    - #8'))!;
    expect(line).not.toContain('TAIL');
    expect(line).toBe(`    - #8 ${'x'.repeat(REASON_CAP - 1)}…`);
  });

  it('collapses a multi-line reason into one bullet and falls back when it is empty', () => {
    const out = formatAgentActionsSection({
      ...emptyData(),
      executed: [
        {
          id: 11, agent: 'merchandiser', action_type: 'marketing_brief', status: 'executed',
          reason: 'line one\n  line two\n\nline three', evidence: '{}', execution_result: null,
          at: '2026-09-17T06:00:00.000Z',
        },
        {
          id: 12, agent: 'merchandiser', action_type: 'restock_flag', status: 'executed',
          reason: '   ', evidence: '{}', execution_result: null, at: '2026-09-17T06:00:01.000Z',
        },
      ],
    })!;
    expect(out).toContain('    - #11 line one line two line three');
    expect(out).toContain('    - #12 (no reason given)');
  });

  it('caps the per-group item list and says how many were elided', () => {
    const executed = Array.from({ length: 9 }, (_, i) => ({
      id: 100 + i, agent: 'marketing-creative', action_type: 'creative_pause' as const,
      status: 'executed' as const, reason: `pause ${i}`, evidence: '{}',
      execution_result: null, at: `2026-09-17T07:0${i}:00.000Z`,
    }));
    const out = formatAgentActionsSection({ ...emptyData(), executed })!;
    expect(out).toContain('  creative_pause x9');
    expect(out).toContain('    - #104 pause 4');
    expect(out).not.toContain('#105');
    expect(out).toContain('    - ...and 4 more');
  });
});

// ---------------------------------------------------------------------------
// The new DB queries
// ---------------------------------------------------------------------------
describe('listExecutedProposalsSince', () => {
  let db: Database.Database;

  function addProposal(row: {
    id: number; agent: string; status: string; created_at: string;
    decided_at?: string | null; action_type?: string; evidence?: string; execution_result?: string | null;
  }): void {
    db.prepare(`
      INSERT INTO proposals (id, agent, brand_id, action_type, action_payload, payload_hash, reason, evidence,
        cost_usd, reversible, level_required, status, created_at, expires_at, decided_at, execution_result)
      VALUES (?, ?, 'dearborn-denim', ?, '{}', ?, ?, ?, 0, 1, 1, ?, ?, '2026-09-30T00:00:00.000Z', ?, ?)
    `).run(
      row.id, row.agent, row.action_type ?? 'creative_pause', `h${row.id}`,
      `reason ${row.id}`, row.evidence ?? '{}', row.status, row.created_at,
      row.decided_at ?? null, row.execution_result ?? null,
    );
  }

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
  });

  it('includes silent auto-executions (decided_at NULL) by created_at and human-approved rows by decided_at', () => {
    // Silent level-3 execution: created inside the window, never decided.
    addProposal({ id: 1, agent: 'marketing-creative', status: 'executed', created_at: '2026-09-17T07:00:00.000Z' });
    // Human-approved: created BEFORE the window, approved inside it — must be included.
    addProposal({
      id: 2, agent: 'sourcing', status: 'executed',
      created_at: '2026-09-10T07:00:00.000Z', decided_at: '2026-09-17T08:00:00.000Z',
    });
    // Human-approved: created inside the window but decided BEFORE it — decided_at wins, excluded.
    addProposal({
      id: 3, agent: 'sourcing', status: 'executed',
      created_at: '2026-09-17T09:00:00.000Z', decided_at: '2026-09-01T00:00:00.000Z',
    });

    const rows = listExecutedProposalsSince(db, SINCE, 100);
    expect(rows.map((r) => r.id)).toEqual([1, 2]);
    expect(rows[0]!.at).toBe('2026-09-17T07:00:00.000Z');
    expect(rows[1]!.at).toBe('2026-09-17T08:00:00.000Z');
  });

  it('applies the window boundary inclusively and excludes anything older', () => {
    addProposal({ id: 10, agent: 'a', status: 'executed', created_at: SINCE });                      // exactly at the boundary
    addProposal({ id: 11, agent: 'a', status: 'executed', created_at: '2026-09-16T09:59:59.999Z' }); // one ms too old
    const rows = listExecutedProposalsSince(db, SINCE, 100);
    expect(rows.map((r) => r.id)).toEqual([10]);
  });

  it('returns executed AND failed but no other status', () => {
    addProposal({ id: 20, agent: 'a', status: 'executed', created_at: '2026-09-17T01:00:00.000Z' });
    addProposal({ id: 21, agent: 'a', status: 'failed', created_at: '2026-09-17T02:00:00.000Z',
      execution_result: '{"ok":false,"http_status":502}' });
    addProposal({ id: 22, agent: 'a', status: 'pending', created_at: '2026-09-17T03:00:00.000Z' });
    addProposal({ id: 23, agent: 'a', status: 'rejected', created_at: '2026-09-17T04:00:00.000Z' });
    addProposal({ id: 24, agent: 'a', status: 'expired', created_at: '2026-09-17T05:00:00.000Z' });

    const rows = listExecutedProposalsSince(db, SINCE, 100);
    expect(rows.map((r) => r.id)).toEqual([20, 21]);
    expect(rows[1]!.status).toBe('failed');
    expect(rows[1]!.execution_result).toBe('{"ok":false,"http_status":502}');
  });

  it('honors the row limit', () => {
    for (let i = 0; i < 6; i++) {
      addProposal({ id: 30 + i, agent: 'a', status: 'executed', created_at: `2026-09-17T0${i}:00:00.000Z` });
    }
    expect(listExecutedProposalsSince(db, SINCE, 2).map((r) => r.id)).toEqual([30, 31]);
  });
});

describe('listLatestRunsSince', () => {
  let db: Database.Database;

  function addRun(r: { run_id: string; agent: string; started_at: string; outcome?: string; notes?: string }): void {
    db.prepare(`
      INSERT INTO agent_run_index (run_id, agent, brand_id, skill_commit, model, started_at, finished_at, outcome, notes)
      VALUES (?, ?, 'dearborn-denim', 'abc123', 'sonnet', ?, ?, ?, ?)
    `).run(r.run_id, r.agent, r.started_at, r.started_at, r.outcome ?? 'ok', r.notes ?? '');
  }

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
  });

  it('returns exactly one row per agent — the newest run in the window', () => {
    addRun({ run_id: 'mc-1', agent: 'marketing-creative', started_at: '2026-09-17T01:00:00.000Z', notes: 'older' });
    addRun({ run_id: 'mc-2', agent: 'marketing-creative', started_at: '2026-09-17T07:15:00.000Z', notes: 'Creative run: 19 ads judged' });
    addRun({ run_id: 'fin-1', agent: 'finance', started_at: '2026-09-17T06:00:00.000Z', outcome: 'nothing_to_do' });

    const rows = listLatestRunsSince(db, SINCE);
    expect(rows.map((r) => r.agent)).toEqual(['finance', 'marketing-creative']); // agent order
    expect(rows.find((r) => r.agent === 'marketing-creative')!.run_id).toBe('mc-2');
    expect(rows.find((r) => r.agent === 'marketing-creative')!.notes).toBe('Creative run: 19 ads judged');
    expect(rows.find((r) => r.agent === 'finance')!.outcome).toBe('nothing_to_do');
  });

  it('excludes runs started before the window and includes one exactly on the boundary', () => {
    addRun({ run_id: 'old-1', agent: 'stale-agent', started_at: '2026-09-15T00:00:00.000Z' });
    addRun({ run_id: 'edge-1', agent: 'edge-agent', started_at: SINCE });
    const rows = listLatestRunsSince(db, SINCE);
    expect(rows.map((r) => r.agent)).toEqual(['edge-agent']);
  });

  it('is empty when no agent ran in the window', () => {
    addRun({ run_id: 'old-2', agent: 'a', started_at: '2026-09-01T00:00:00.000Z' });
    expect(listLatestRunsSince(db, SINCE)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The loader
// ---------------------------------------------------------------------------
describe('loadAgentActionsData', () => {
  it('assembles executed + pending + runs over a 24h window ending at now', () => {
    const db = new Database(':memory:');
    initializeSchema(db);
    db.prepare(`
      INSERT INTO proposals (id, agent, brand_id, action_type, action_payload, payload_hash, reason, evidence,
        cost_usd, reversible, level_required, status, created_at, expires_at)
      VALUES (1, 'marketing-creative', 'dearborn-denim', 'creative_pause', '{}', 'h1', 'Stock: 2+ sizes sold out',
        '{"ad_name":"DD Fall Hook A","external_ad_id":"120330111"}', 0, 1, 3, 'executed',
        '2026-09-17T07:15:00.000Z', '2026-09-24T00:00:00.000Z')
    `).run();
    db.prepare(`
      INSERT INTO proposals (id, agent, brand_id, action_type, action_payload, payload_hash, reason, evidence,
        cost_usd, reversible, level_required, status, created_at, expires_at)
      VALUES (2, 'sourcing', 'dearborn-denim', 'rfq_send', '{}', 'h2', 'RFQ to Carr Textile', '{}',
        0, 0, 1, 'pending', '2026-09-17T08:00:00.000Z', '2026-09-17T20:00:00.000Z')
    `).run();
    db.prepare(`
      INSERT INTO agent_run_index (run_id, agent, brand_id, skill_commit, model, started_at, finished_at, outcome, notes)
      VALUES ('mc-2', 'marketing-creative', 'dearborn-denim', 'abc', 'sonnet',
        '2026-09-17T07:15:00.000Z', '2026-09-17T07:17:00.000Z', 'ok', 'Creative run: 19 ads judged')
    `).run();

    const data = loadAgentActionsData(db, new Date(NOW))!;
    expect(data.since).toBe(SINCE);
    expect(data.now).toBe(NOW);
    expect(data.executed.map((r) => r.id)).toEqual([1]);
    expect(data.pending.map((r) => r.id)).toEqual([2]);
    expect(data.runs.map((r) => r.agent)).toEqual(['marketing-creative']);

    const rendered = formatAgentActionsSection(data)!;
    expect(rendered).toContain('    - #1 Stock: 2+ sizes sold out (ad: DD Fall Hook A / 120330111)');
    expect(rendered).toContain('- sourcing — 1 pending: #2 (expiring within 24h: #2)');
    expect(rendered).toContain('- marketing-creative (ok): Creative run: 19 ads judged');
  });

  it('returns null instead of throwing when the spine tables are missing', () => {
    const bare = new Database(':memory:'); // no schema at all
    expect(loadAgentActionsData(bare, new Date(NOW))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Section registration + gating
// ---------------------------------------------------------------------------
describe('agent_actions section registration and gating', () => {
  const STATS = { totalProcessed: 5, archived: 3, flaggedForReview: 2 };
  const BLOCK = 'WHAT THE AGENTS DID (last 24h):\n\nEXECUTED (1):\nmarketing-creative — 1';

  it('is a registered section name with a description (lockstep with the catalog)', () => {
    expect(isValidBriefingSection('agent_actions')).toBe(true);
    expect(VALID_BRIEFING_SECTIONS).toContain('agent_actions');
    expect(BRIEFING_SECTION_DESCRIPTIONS.agent_actions.length).toBeGreaterThan(0);
    // Placed right after overnight_dev, before production.
    const idx = VALID_BRIEFING_SECTIONS.indexOf('agent_actions');
    expect(VALID_BRIEFING_SECTIONS[idx - 1]).toBe('overnight_dev');
    expect(VALID_BRIEFING_SECTIONS[idx + 1]).toBe('production');
  });

  it('renders in the prompt when supplied and is absent when it is not (member briefing)', () => {
    const withBlock = buildBriefingPrompt([], STATS, undefined, undefined, undefined, undefined, undefined, undefined, undefined, BLOCK);
    expect(withBlock).toContain('WHAT THE AGENTS DID');

    const without = buildBriefingPrompt([], STATS);
    expect(without).not.toContain('WHAT THE AGENTS DID');
  });

  it('is suppressed by a section filter that omits it, and kept by one that includes it', () => {
    const filteredOut = buildBriefingPrompt([], STATS, undefined, undefined, undefined, undefined, undefined, undefined, ['stats'], BLOCK);
    expect(filteredOut).not.toContain('WHAT THE AGENTS DID');
    expect(filteredOut).toContain('Stats:');

    const kept = buildBriefingPrompt([], STATS, undefined, undefined, undefined, undefined, undefined, undefined, ['agent_actions'], BLOCK);
    expect(kept).toContain('WHAT THE AGENTS DID');
    expect(kept).not.toContain('Stats:');
  });

  it('sits between overnight_dev and production in the default render order', () => {
    const prompt = buildBriefingPrompt(
      [], STATS, undefined, 'OVERNIGHT DEV REPORT body', 'PRODUCTION_HEADER_MARKER body',
      undefined, undefined, undefined, undefined, BLOCK,
    );
    const overnight = prompt.indexOf('OVERNIGHT DEV REPORT');
    const agents = prompt.indexOf('WHAT THE AGENTS DID');
    const production = prompt.indexOf('PRODUCTION_HEADER_MARKER');
    expect(overnight).toBeGreaterThan(-1);
    expect(agents).toBeGreaterThan(overnight);
    expect(production).toBeGreaterThan(agents);
  });

  it('triage.ts gathers the section inside the admin-only branch, like adminOps', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'triage.ts'), 'utf-8');

    const adminGate = source.indexOf("user?.role === 'admin'");
    const loaderCall = source.indexOf('loadAgentActionsData(db, now)');
    const adminOpsAssign = source.indexOf('adminOps = ops;');
    expect(adminGate).toBeGreaterThan(-1);
    expect(loaderCall).toBeGreaterThan(adminGate);
    expect(loaderCall).toBeLessThan(adminOpsAssign);
    // ...and it is the LAST positional argument handed to generateBriefing.
    expect(source).toContain('sectionsOrdered, agentActionsSection)');
  });
});
