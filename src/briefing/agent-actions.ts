/**
 * "What the agents did" — the agent-spine section of the admin morning
 * briefing (2026-09-17).
 *
 * Why this exists: Robert promoted marketing-creative's per-ad actions
 * (creative_pause / creative_resume / creative_cut / creative_promote) to
 * trust level 3. At level 3 a reversible, $0 proposal executes SILENTLY —
 * `fileProposal` returns `executed_silent` and sends no Telegram message
 * (src/spine/router.ts). That is deliberate: he does not want a card per ad.
 * But "silent" must not mean "invisible", so the 5 AM briefing becomes the
 * one place overnight agent activity shows up.
 *
 * Four blocks, in this order:
 *   1. FAILED   — executions that failed in the window. Failures first: a
 *                 silent action that silently failed is the worst case.
 *   2. EXECUTED — grouped by agent, then action type, with counts.
 *   3. STILL WAITING ON YOU — pending cards per agent, plus anything about
 *                 to expire.
 *   4. RUN NOTES — the newest run per agent, outcome + notes verbatim.
 *
 * `formatAgentActionsSection` is pure: it takes plain rows and returns a
 * string, or null when nothing happened (the section then renders nothing at
 * all rather than a "nothing to report" header). `loadAgentActionsData` does
 * the DB reads and follows the graceful-failure contract used by wip.ts /
 * inventory.ts — ANY error returns null, the briefing never crashes on this.
 *
 * Timestamps: the `proposals` table has no `executed_at` column. A human-
 * decided row carries `decided_at`; a level-2/3 auto-execution is performed
 * inline by `fileProposal` immediately after the insert and never sets
 * `decided_at`, so its `created_at` IS its execution time. The window is
 * therefore `COALESCE(decided_at, created_at) >= since` — see
 * `listExecutedProposalsSince` in src/db/proposal-queries.ts.
 */

import type Database from 'better-sqlite3';
import { listExecutedProposalsSince, listPendingProposals } from '../db/proposal-queries.js';
import { listLatestRunsSince } from '../db/run-index-queries.js';

/** Max chars of a proposal `reason` carried into the briefing. */
export const REASON_CAP = 120;
/** Max chars of a failed execution's error detail. */
const ERROR_CAP = 100;
/** Max per-item lines rendered under one (agent, action_type) group. */
const MAX_ITEMS_PER_GROUP = 5;
/** Max pending ids listed per agent before eliding. */
const MAX_PENDING_IDS = 8;
/** Hard ceiling on rows pulled for the window — a runaway agent can't blow up the prompt. */
const EXECUTED_ROW_LIMIT = 500;

const WINDOW_MS = 24 * 60 * 60 * 1000;

/** One executed-or-failed proposal in the window. */
export interface AgentActionRow {
  id: number;
  agent: string;
  action_type: string;
  status: 'executed' | 'failed';
  reason: string;
  /** Raw `proposals.evidence` JSON text (may be malformed — parsed defensively). */
  evidence: string | null;
  /** Raw `proposals.execution_result` JSON text. */
  execution_result: string | null;
  /** COALESCE(decided_at, created_at) — when the execution landed. */
  at: string;
}

/** One proposal still sitting on a Telegram card. */
export interface AgentPendingRow {
  id: number;
  agent: string;
  action_type: string;
  expires_at: string;
}

/** The newest run for one agent inside the window. */
export interface AgentRunNoteRow {
  agent: string;
  run_id: string;
  outcome: string;
  notes: string;
  started_at: string;
}

export interface AgentActionsData {
  /** ISO start of the window (now - 24h). */
  since: string;
  /** ISO 'now' the briefing is being built for. */
  now: string;
  executed: AgentActionRow[];
  pending: AgentPendingRow[];
  runs: AgentRunNoteRow[];
}

/** Collapse all whitespace runs to single spaces so a multi-line reason stays one bullet. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Truncate to `cap` chars INCLUDING the ellipsis, so output never exceeds the cap. */
export function truncate(s: string, cap: number): string {
  if (s.length <= cap) return s;
  return `${s.slice(0, cap - 1)}…`;
}

function parseObject(json: string | null): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as unknown;
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
    return v as Record<string, unknown>;
  } catch {
    return null;
  }
}

function stringField(rec: Record<string, unknown>, key: string): string | null {
  const v = rec[key];
  if (typeof v === 'string') {
    const t = v.trim();
    return t.length > 0 ? t : null;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

/**
 * ` (ad: <name> / <id>)` when the proposal's evidence names the ad — the
 * marketing-creative rows carry `ad_name` and `external_ad_id`. Degrades to
 * whichever half is present, and to '' when evidence has neither, is
 * malformed, or is missing entirely. Presence-driven rather than
 * agent-driven, so any agent adopting the same evidence keys gets it.
 */
export function formatAdRef(evidenceJson: string | null): string {
  const ev = parseObject(evidenceJson);
  if (!ev) return '';
  const name = stringField(ev, 'ad_name');
  const id = stringField(ev, 'external_ad_id');
  if (name && id) return ` (ad: ${name} / ${id})`;
  if (name) return ` (ad: ${name})`;
  if (id) return ` (ad id: ${id})`;
  return '';
}

/** ` [<error> HTTP <status>]` from a failed row's execution_result, or ''. */
function failureDetail(resultJson: string | null): string {
  const r = parseObject(resultJson);
  if (!r) return '';
  const parts: string[] = [];
  const err = stringField(r, 'error');
  if (err) parts.push(err);
  const status = r.http_status;
  if (typeof status === 'number' && Number.isFinite(status)) parts.push(`HTTP ${status}`);
  if (parts.length === 0) return '';
  return ` [${truncate(collapse(parts.join(' ')), ERROR_CAP)}]`;
}

function reasonOf(row: AgentActionRow): string {
  const r = truncate(collapse(row.reason ?? ''), REASON_CAP);
  return r.length > 0 ? r : '(no reason given)';
}

function groupBy<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const bucket = out.get(k);
    if (bucket) bucket.push(r);
    else out.set(k, [r]);
  }
  return out;
}

function sortedKeys(m: Map<string, unknown>): string[] {
  return [...m.keys()].sort((a, b) => a.localeCompare(b));
}

/**
 * Render the section, or null when there is nothing at all to say (no
 * executions, no failures, no pending cards, no runs). Null means the
 * briefing prompt gets no `agent_actions` block whatsoever.
 */
export function formatAgentActionsSection(data: AgentActionsData): string | null {
  const failed = data.executed.filter((r) => r.status === 'failed');
  const ok = data.executed.filter((r) => r.status === 'executed');

  if (failed.length === 0 && ok.length === 0 && data.pending.length === 0 && data.runs.length === 0) {
    return null;
  }

  const lines: string[] = ['WHAT THE AGENTS DID (last 24h):'];

  if (failed.length > 0) {
    lines.push('');
    lines.push(`FAILED (${failed.length}):`);
    for (const r of failed) {
      lines.push(
        `- ${r.agent} ${r.action_type} #${r.id} — ${reasonOf(r)}${formatAdRef(r.evidence)}${failureDetail(r.execution_result)}`,
      );
    }
  }

  if (ok.length > 0) {
    lines.push('');
    lines.push(`EXECUTED (${ok.length}):`);
    const byAgent = groupBy(ok, (r) => r.agent);
    for (const agent of sortedKeys(byAgent)) {
      const rows = byAgent.get(agent)!;
      lines.push(`${agent} — ${rows.length}`);
      const byType = groupBy(rows, (r) => r.action_type);
      // Biggest group first so the dominant action reads at a glance; ties by name.
      const types = [...byType.entries()].sort(
        (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
      );
      for (const [actionType, items] of types) {
        lines.push(`  ${actionType} x${items.length}`);
        for (const r of items.slice(0, MAX_ITEMS_PER_GROUP)) {
          lines.push(`    - #${r.id} ${reasonOf(r)}${formatAdRef(r.evidence)}`);
        }
        if (items.length > MAX_ITEMS_PER_GROUP) {
          lines.push(`    - ...and ${items.length - MAX_ITEMS_PER_GROUP} more`);
        }
      }
    }
  }

  if (data.pending.length > 0) {
    const expiryCutoff = new Date(Date.parse(data.now) + WINDOW_MS).toISOString();
    lines.push('');
    lines.push(`STILL WAITING ON YOU (${data.pending.length}):`);
    const byAgent = groupBy(data.pending, (r) => r.agent);
    for (const agent of sortedKeys(byAgent)) {
      const rows = byAgent.get(agent)!;
      const ids = rows.slice(0, MAX_PENDING_IDS).map((r) => `#${r.id}`).join(', ');
      const more = rows.length > MAX_PENDING_IDS ? `, +${rows.length - MAX_PENDING_IDS} more` : '';
      const expiring = rows.filter((r) => r.expires_at <= expiryCutoff);
      const expiringNote = expiring.length > 0
        ? ` (expiring within 24h: ${expiring.map((r) => `#${r.id}`).join(', ')})`
        : '';
      lines.push(`- ${agent} — ${rows.length} pending: ${ids}${more}${expiringNote}`);
    }
  }

  if (data.runs.length > 0) {
    lines.push('');
    lines.push('RUN NOTES:');
    for (const r of [...data.runs].sort((a, b) => a.agent.localeCompare(b.agent))) {
      // Notes are surfaced verbatim (only whitespace-collapsed, so one run stays
      // one bullet) — the marketing-creative run-end one-liner is the payload.
      const note = collapse(r.notes ?? '');
      lines.push(`- ${r.agent} (${r.outcome})${note ? `: ${note}` : ''}`);
    }
  }

  return lines.join('\n');
}

/**
 * Read the last 24h of spine activity. Returns null on ANY failure (missing
 * tables on an old DB, a locked handle, malformed rows) so the briefing
 * degrades to "no agent section" instead of throwing — same contract as
 * fetchWipSummary / fetchInventoryOverview.
 */
export function loadAgentActionsData(db: Database.Database, now: Date): AgentActionsData | null {
  try {
    const nowIso = now.toISOString();
    const sinceIso = new Date(now.getTime() - WINDOW_MS).toISOString();

    const executed: AgentActionRow[] = listExecutedProposalsSince(db, sinceIso, EXECUTED_ROW_LIMIT).map((r) => ({
      id: r.id,
      agent: r.agent,
      action_type: r.action_type,
      status: r.status,
      reason: r.reason,
      evidence: r.evidence,
      execution_result: r.execution_result,
      at: r.at,
    }));

    const pending: AgentPendingRow[] = listPendingProposals(db).map((r) => ({
      id: r.id,
      agent: r.agent,
      action_type: r.action_type,
      expires_at: r.expires_at,
    }));

    const runs: AgentRunNoteRow[] = listLatestRunsSince(db, sinceIso).map((r) => ({
      agent: r.agent,
      run_id: r.run_id,
      outcome: r.outcome,
      notes: r.notes,
      started_at: r.started_at,
    }));

    return { since: sinceIso, now: nowIso, executed, pending, runs };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`Skipping agent actions section: ${msg}`);
    return null;
  }
}
