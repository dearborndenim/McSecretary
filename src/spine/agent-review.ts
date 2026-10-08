/**
 * Monthly agent review (spec docs/superpowers/specs/2026-10-08-agent-review-job-design.md).
 *
 * One phone-length Telegram message telling Robert which business agents
 * produced decisions he acted on, which produced cards he ignored, which are
 * broken or idle, which only act silently, and which action types have earned
 * a promotion. Sent by the Trust Monthly Summary job (before the trust text)
 * and on demand by `/agentreview [days]`.
 *
 * Both functions here are pure: `computeAgentReview` takes plain rows (read by
 * src/db/review-queries.ts) and does every window test itself, so the SQL can
 * stay broad; `formatAgentReview` renders the message.
 */

import { isPinned } from './gates.js';
import { TIMEZONE } from '../calendar/types.js';

// ── Flag thresholds (spec §3) ───────────────────────────────────────────────
/** IGNORED needs at least this many cards, and then none decided… */
export const IGNORED_MIN_CARDS = 10;
/** …or expired cards ÷ cards at least this share. */
export const IGNORED_EXPIRED_SHARE = 0.5;
/** IDLE: at least this many runs… */
export const IDLE_MIN_RUNS = 10;
/** …and (nothing_to_do + failed) ÷ runs at least this share. */
export const IDLE_SHARE = 0.8;
/** BROKEN: at least this many runs… */
export const BROKEN_MIN_RUNS = 4;
/** …and failed ÷ runs at least this share. */
export const BROKEN_SHARE = 0.5;
/** BROKEN also fires on this many failed auto-executions, when they are at least the successful ones. */
export const BROKEN_MIN_AUTO_FAILED = 5;
/** NOISY: this many cards or more. */
export const NOISY_MIN_CARDS = 20;
/** SILENT ONLY: this many auto-executions or more with zero cards. */
export const SILENT_MIN_AUTO = 20;
/** PROMOTE?: approved as proposed at least this many times, lifetime, 0 edits/rejections. */
export const PROMOTE_MIN_APPROVED = 5;
/** An action type with this many rejections in the window is listed. */
export const REJECTED_TYPE_MIN = 2;
/** A run still `running` this long after it started counts as failed. */
export const STALE_RUNNING_MS = 24 * 60 * 60 * 1000;
/** Chars of a failed run's notes used to find the most common failure. */
export const BROKEN_NOTE_CHARS = 80;

// ── Message limits (spec §4) ────────────────────────────────────────────────
export const MAX_MESSAGE_CHARS = 1500;
/** Names per section line before "+N". */
export const MAX_NAMES = 5;
/** Agents named on the Cost line. */
export const COST_TOP = 3;
export const PARK_HINT = 'Park an agent: launchctl unload on the Mac mini (agents/README.md → Fleet review).';

export type AgentFlag = 'IGNORED' | 'IDLE' | 'BROKEN' | 'NOISY' | 'PROMOTE?' | 'SILENT ONLY';

export interface ReviewProposalRow {
  agent: string;
  action_type: string;
  status: string;
  created_at: string;
  decided_at: string | null;
  telegram_message_id: number | null;
}

export interface ReviewRunRow {
  agent: string;
  outcome: string;
  started_at: string;
  notes: string;
  cost_usd: number | null;
}

export interface ReviewTrustRow {
  agent: string;
  action_type: string;
  level: number;
  approved_as_proposed: number;
  approved_with_edit: number;
  rejected: number;
}

export interface AgentStats {
  agent: string;
  runs: number;
  ok: number;
  nothing: number;
  /** hand_error + contract_violation + `running` older than 24 h. */
  failed: number;
  /** Proposals that reached Robert as a Telegram card, created in the window. */
  cards: number;
  /** Cards created in the window and decided (approve / edit / reject) in it — a subset of `cards`. */
  decided: number;
  /** Cards created in the window that expired undecided. */
  ignored: number;
  /** Executed with no card (level 2/3 auto-execution), created in the window. */
  auto: number;
  /** Auto-executions (no card) that failed, created in the window. */
  autoFailed: number;
  /** Action types with >= REJECTED_TYPE_MIN rejections in the window. */
  rejectedTypes: Array<{ action_type: string; count: number }>;
  /** Σ run cost_usd; null when no run in the window reported one. */
  costUsd: number | null;
  /** cost ÷ decided; Infinity when nothing was decided; null when cost is n/a. */
  costPerDecision: number | null;
  /** Most common first-80-chars of a failed run's notes (BROKEN only). */
  brokenNote: string | null;
  flags: AgentFlag[];
}

export interface PromoteCandidate {
  agent: string;
  action_type: string;
  approved: number;
}

export interface AgentReview {
  since: string;
  until: string;
  /** Every agent with a run or proposal in the window, by name. */
  agents: AgentStats[];
  promote: PromoteCandidate[];
  /** Σ cost over all agents; null when no run reported cost. */
  totalCostUsd: number | null;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_LIKE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/;
const HAS_ZONE = /(?:Z|[+-]\d{2}:\d{2})$/i;

/**
 * Timestamp → ms. A date-only value is midnight UTC; an ISO-like value with no
 * zone (SQLite `datetime('now')` text, "YYYY-MM-DD HH:MM:SS") is UTC; anything
 * else goes to Date.parse as-is (what `POST /spine/runs` accepts).
 */
export function toMs(ts: string | null): number {
  if (!ts) return NaN;
  if (DATE_ONLY.test(ts)) return Date.parse(`${ts}T00:00:00Z`);
  if (ISO_LIKE.test(ts) && !HAS_ZONE.test(ts)) return Date.parse(`${ts.replace(' ', 'T')}Z`);
  return Date.parse(ts);
}

const DECIDED_STATUSES = new Set(['approved', 'approved_with_edit', 'rejected', 'executed', 'failed']);

function emptyStats(agent: string): AgentStats {
  return {
    agent, runs: 0, ok: 0, nothing: 0, failed: 0, cards: 0, decided: 0, ignored: 0, auto: 0, autoFailed: 0,
    rejectedTypes: [], costUsd: null, costPerDecision: null, brokenNote: null, flags: [],
  };
}

export function computeAgentReview(input: {
  proposals: ReviewProposalRow[];
  runs: ReviewRunRow[];
  trust: ReviewTrustRow[];
  sinceIso: string;
  nowIso: string;
}): AgentReview {
  const since = toMs(input.sinceIso);
  const now = toMs(input.nowIso);
  const inWindow = (ts: string | null): boolean => { const t = toMs(ts); return t >= since && t <= now; };

  const byAgent = new Map<string, AgentStats>();
  const stats = (agent: string): AgentStats => {
    let s = byAgent.get(agent);
    if (!s) { s = emptyStats(agent); byAgent.set(agent, s); }
    return s;
  };
  const failedNotes = new Map<string, string[]>();
  const rejections = new Map<string, Map<string, number>>();

  for (const r of input.runs) {
    if (!inWindow(r.started_at)) continue;
    const s = stats(r.agent);
    s.runs++;
    if (typeof r.cost_usd === 'number' && Number.isFinite(r.cost_usd)) s.costUsd = (s.costUsd ?? 0) + r.cost_usd;
    const failed = r.outcome === 'hand_error' || r.outcome === 'contract_violation'
      || (r.outcome === 'running' && now - toMs(r.started_at) > STALE_RUNNING_MS);
    if (r.outcome === 'ok') s.ok++;
    else if (r.outcome === 'nothing_to_do') s.nothing++;
    else if (failed) {
      s.failed++;
      const note = (r.notes ?? '').trim().slice(0, BROKEN_NOTE_CHARS);
      if (note) {
        const list = failedNotes.get(r.agent) ?? [];
        list.push(note);
        failedNotes.set(r.agent, list);
      }
    }
  }

  for (const p of input.proposals) {
    // Every count is over proposals created in the window, so decided ≤ cards.
    if (!inWindow(p.created_at)) continue;
    const hasCard = p.telegram_message_id !== null;
    const s = stats(p.agent);
    if (hasCard) {
      s.cards++;
      if (p.status === 'expired') s.ignored++;
      if (DECIDED_STATUSES.has(p.status) && inWindow(p.decided_at)) s.decided++;
    } else if (p.status === 'executed') s.auto++;
    else if (p.status === 'failed') s.autoFailed++;
    if (p.status === 'rejected' && inWindow(p.decided_at)) {
      const m = rejections.get(p.agent) ?? new Map<string, number>();
      m.set(p.action_type, (m.get(p.action_type) ?? 0) + 1);
      rejections.set(p.agent, m);
    }
  }

  // PROMOTE?: summed over brands per (agent, action_type); every brand row must qualify.
  const promoteMap = new Map<string, PromoteCandidate & { ok: boolean }>();
  for (const t of input.trust) {
    const key = `${t.agent}\u0000${t.action_type}`;
    const c = promoteMap.get(key) ?? { agent: t.agent, action_type: t.action_type, approved: 0, ok: true };
    c.approved += t.approved_as_proposed;
    if (t.level !== 1 || isPinned(t.action_type) || t.approved_with_edit > 0 || t.rejected > 0) c.ok = false;
    promoteMap.set(key, c);
  }
  const promote = [...promoteMap.values()]
    .filter((c) => c.ok && c.approved >= PROMOTE_MIN_APPROVED)
    .map(({ agent, action_type, approved }) => ({ agent, action_type, approved }))
    .sort((a, b) => b.approved - a.approved || a.agent.localeCompare(b.agent) || a.action_type.localeCompare(b.action_type));
  const promoteAgents = new Set(promote.map((c) => c.agent));

  let totalCostUsd: number | null = null;
  for (const s of byAgent.values()) {
    const m = rejections.get(s.agent);
    if (m) {
      s.rejectedTypes = [...m.entries()]
        .filter(([, n]) => n >= REJECTED_TYPE_MIN)
        .map(([action_type, count]) => ({ action_type, count }))
        .sort((a, b) => b.count - a.count || a.action_type.localeCompare(b.action_type));
    }
    if (s.costUsd !== null) {
      totalCostUsd = (totalCostUsd ?? 0) + s.costUsd;
      s.costPerDecision = s.decided > 0 ? s.costUsd / s.decided : Infinity;
    }

    if (s.cards >= IGNORED_MIN_CARDS && (s.decided === 0 || s.ignored / s.cards >= IGNORED_EXPIRED_SHARE)) s.flags.push('IGNORED');
    if (s.runs >= IDLE_MIN_RUNS && (s.nothing + s.failed) / s.runs >= IDLE_SHARE) s.flags.push('IDLE');
    const runsBroken = s.runs >= BROKEN_MIN_RUNS && s.failed / s.runs >= BROKEN_SHARE;
    const autoBroken = s.autoFailed >= BROKEN_MIN_AUTO_FAILED && s.autoFailed >= s.auto;
    if (runsBroken || autoBroken) {
      s.flags.push('BROKEN');
      s.brokenNote = mostCommon(failedNotes.get(s.agent) ?? []);
    }
    if (s.cards >= NOISY_MIN_CARDS) s.flags.push('NOISY');
    if (promoteAgents.has(s.agent)) s.flags.push('PROMOTE?');
    if (s.auto >= SILENT_MIN_AUTO && s.cards === 0) s.flags.push('SILENT ONLY');
  }

  return {
    since: input.sinceIso,
    until: input.nowIso,
    agents: [...byAgent.values()].sort((a, b) => a.agent.localeCompare(b.agent)),
    promote,
    totalCostUsd,
  };
}

/** Mode of the list; ties go to the value seen first. */
function mostCommon(values: string[]): string | null {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: string | null = null;
  let bestN = 0;
  for (const [v, n] of counts) if (n > bestN) { best = v; bestN = n; }
  return best;
}

// ── Formatting ──────────────────────────────────────────────────────────────

function money(n: number): string {
  if (n > 0 && n < 1) return `$${n.toFixed(2)}`;
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

function day(iso: string): string {
  return new Date(toMs(iso)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: TIMEZONE });
}

/** "a · b · c +N" — at most `max` items. */
function cap(items: string[], max: number): string {
  const shown = items.slice(0, max).join(' · ');
  return items.length > max ? `${shown} +${items.length - max}` : shown;
}

function byDesc<T>(rows: T[], n: (r: T) => number, name: (r: T) => string): T[] {
  return [...rows].sort((a, b) => n(b) - n(a) || name(a).localeCompare(name(b)));
}

function render(review: AgentReview, maxNames: number, allNotes: boolean): string {
  const a = review.agents;
  const has = (s: AgentStats, f: AgentFlag) => s.flags.includes(f);
  const name = (s: AgentStats) => s.agent;
  const lines: string[] = [`Agent review — ${day(review.since)} → ${day(review.until)}`];
  const section = (label: string, items: string[]) => { if (items.length) lines.push(`${label}: ${cap(items, maxNames)}`); };

  section('Decided on', byDesc(a.filter((s) => s.decided > 0 && !has(s, 'IGNORED')), (s) => s.decided, name)
    .map((s, i) => `${s.agent} ${s.decided}/${s.cards}${i === 0 ? ' cards' : ''}${s.auto > 0 ? `, ${s.auto} auto` : ''}`));

  section('Ignored', byDesc(a.filter((s) => has(s, 'IGNORED')), (s) => s.cards, name)
    .map((s) => `${s.agent} ${s.cards} cards, ${s.decided} decided`));

  section('Noisy', byDesc(a.filter((s) => has(s, 'NOISY') && !has(s, 'IGNORED')), (s) => s.cards, name)
    .map((s, i) => `${s.agent} ${s.cards}${i === 0 ? ' cards' : ''}`));

  section('Broken', byDesc(a.filter((s) => has(s, 'BROKEN')), (s) => s.failed + s.autoFailed, name)
    .map((s, i) => {
      const parts: string[] = [];
      if (s.failed > 0) parts.push(`${s.failed}/${s.runs} runs failed`);
      if (s.autoFailed > 0) parts.push(`${s.autoFailed} auto failed`);
      const note = s.brokenNote && (allNotes || i === 0) ? ` — "${s.brokenNote}"` : '';
      return `${s.agent} ${parts.join(', ')}${note}`;
    }));

  section('Idle', byDesc(a.filter((s) => has(s, 'IDLE')), (s) => s.nothing + s.failed, name)
    .map((s) => has(s, 'BROKEN') ? s.agent
      : `${s.agent} ${s.nothing + s.failed}/${s.runs} runs nothing or failed`));

  section('Silent only', byDesc(a.filter((s) => has(s, 'SILENT ONLY')), (s) => s.auto, name)
    .map((s, i) => `${s.agent} ${s.auto} auto${i === 0 ? ', 0 cards' : ''}`));

  const rejected = a.flatMap((s) => s.rejectedTypes.map((t) => ({ key: `${s.agent}/${t.action_type}`, count: t.count })));
  section('Rejected', byDesc(rejected, (r) => r.count, (r) => r.key)
    .map((r, i) => `${r.key} ${r.count}${i === 0 ? ' rejections' : ''}`));

  section('Promote?', review.promote
    .map((c, i) => `${c.agent}/${c.action_type} (${i === 0 ? `${c.approved} approved, 0 edits` : `${c.approved}/0`})`));

  if (a.length > 0) {
    if (review.totalCostUsd === null) {
      lines.push('Cost: n/a');
    } else {
      const top = byDesc(a.filter((s) => s.costUsd !== null), (s) => s.costUsd!, name).slice(0, COST_TOP);
      const per = top.map((s) => `${s.agent} ${s.decided > 0 ? money(s.costPerDecision!)
        : s.auto > 0 ? `${money(s.costUsd! / s.auto)} per auto-run` : 'no decisions'}`);
      lines.push(`Cost: ${money(review.totalCostUsd)} (${top.map((s) => `${s.agent} ${money(s.costUsd!)}`).join(' · ')}) — $/decision: ${per.join(', ')}`);
    }
  } else {
    lines.push('No agent runs or proposals in the window.');
  }

  if (a.some((s) => has(s, 'IGNORED') || has(s, 'IDLE') || has(s, 'BROKEN') || has(s, 'SILENT ONLY') || has(s, 'NOISY'))) {
    lines.push(PARK_HINT);
  }
  return lines.join('\n');
}

/**
 * The review message. Each section is one line, at most MAX_NAMES names then
 * "+N", empty sections omitted. To stay under MAX_MESSAGE_CHARS it first keeps
 * only the top broken agent's note, then names fewer agents per line.
 */
export function formatAgentReview(review: AgentReview): string {
  let text = render(review, MAX_NAMES, true);
  if (text.length < MAX_MESSAGE_CHARS) return text;
  for (let n = MAX_NAMES; n >= 1; n--) {
    text = render(review, n, false);
    if (text.length < MAX_MESSAGE_CHARS) return text;
  }
  return `${text.slice(0, MAX_MESSAGE_CHARS - 2)}…`;
}
