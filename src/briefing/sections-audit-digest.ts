/**
 * Daily admin digest of `/briefing-sections` preference changes.
 *
 * Shipped 2026-04-25 (Task 6 — Briefing UX polish 3).
 *
 * Reads `briefing_sections_audit` for rows whose `ts` is within the trailing
 * 24h window and renders a text-only summary suitable for sending to the admin
 * via email or Telegram. The 7 AM CT scheduler job calls
 * `runBriefingSectionsAuditDigest(db, opts)` once per day. When there is
 * nothing to report the function returns `null` (no message sent), keeping
 * the empty case quiet by default.
 *
 * Wiring: scheduler in `src/index.ts` adds a "Briefing Audit Digest" entry on
 * cron `0 7 * * *` (7 AM, runs daily). Unset `BRIEFING_AUDIT_DIGEST_RECIPIENT`
 * → digest text is logged only (safe default for new deploys). Set
 * `DISABLE_BRIEFING_AUDIT_DIGEST=1` → job no-ops.
 */
import type Database from 'better-sqlite3';
import {
  getBriefingSectionsAuditSince,
  type BriefingSectionsAuditRow,
} from '../db/user-queries.js';

export interface AuditDigestDeps {
  /** Overridable now() for tests; defaults to `new Date()`. */
  now?: () => Date;
  /** Overridable env reader; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

/**
 * Build the rendered digest text from a list of audit rows. Pure — accepts
 * already-loaded rows so tests can drive the formatter without a DB.
 *
 * Returns `null` when `rows` is empty so callers can short-circuit on the
 * empty case.
 */
export function formatBriefingSectionsAuditDigest(
  rows: BriefingSectionsAuditRow[],
  windowHours: number = 24,
): string | null {
  if (rows.length === 0) return null;

  // Group by action type. Iterate in canonical order so the digest is stable.
  // Polish 5 (2026-04-27) added 'revert' as a tracked action group.
  const groups: Record<string, BriefingSectionsAuditRow[]> = {
    set: [],
    reset: [],
    'set-all': [],
    'clone-from': [],
    revert: [],
  };
  for (const row of rows) {
    const bucket = groups[row.action];
    if (bucket) bucket.push(row);
  }

  const lines: string[] = [];
  lines.push(
    `Briefing-sections preference changes in the last ${windowHours}h: ${rows.length}`,
  );

  const actionOrder: BriefingSectionsAuditRow['action'][] = [
    'set',
    'reset',
    'set-all',
    'clone-from',
    'revert',
  ];

  // Polish 5 — per-action count summary. Suppresses sections with zero
  // counts so the digest stays tight. Renders inline on one line:
  //   "By action: set=2, reset=1, revert=4"
  const summaryParts: string[] = [];
  for (const action of actionOrder) {
    const items = groups[action];
    if (!items || items.length === 0) continue;
    summaryParts.push(`${action}=${items.length}`);
  }
  if (summaryParts.length > 0) {
    lines.push(`By action: ${summaryParts.join(', ')}`);
  }
  lines.push('');

  for (const action of actionOrder) {
    const items = groups[action];
    if (!items || items.length === 0) continue;
    lines.push(`${action} (${items.length}):`);
    for (const row of items) {
      lines.push(`  - ${formatAuditLine(row)}`);
    }
    lines.push('');
  }

  // Drop the trailing blank from the last group.
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

/**
 * Format one audit row as a single bullet line. Keeps the digest scannable
 * on a phone screen.
 */
function formatAuditLine(row: BriefingSectionsAuditRow): string {
  const prefix = `${row.user_name}`;
  switch (row.action) {
    case 'set':
      return `${prefix} → ${describeSections(row.sections_json)}`;
    case 'reset':
      return `${prefix} → (default: full briefing)`;
    case 'set-all':
      return `${prefix} (bulk) → ${describeSections(row.sections_json)}`;
    case 'clone-from':
      return `${prefix} ← cloned from ${row.source_user ?? '(unknown)'} → ${describeSections(row.sections_json)}`;
    case 'revert':
      // source_user, when present, is `audit:<id>` — the targeted historical
      // row id. Include the trailing breadcrumb so admins can trace the
      // revert back to the row it pointed at.
      return `${prefix} (revert${row.source_user ? ` ${row.source_user}` : ''}) → ${describeSections(row.sections_json)}`;
    default:
      return `${prefix} (unknown action: ${row.action})`;
  }
}

function describeSections(sectionsJson: string | null): string {
  if (sectionsJson === null) return '(default: full briefing)';
  try {
    const parsed = JSON.parse(sectionsJson);
    if (Array.isArray(parsed)) {
      const strs = parsed.filter((x): x is string => typeof x === 'string');
      return strs.length === 0 ? '(default: full briefing)' : strs.join(', ');
    }
  } catch {
    /* fall through */
  }
  return '(default: full briefing)';
}

export interface RunAuditDigestResult {
  ran: boolean;
  rowCount: number;
  message: string | null;
  reason?: 'disabled' | 'empty' | 'sent';
}

/**
 * Parse `BRIEFING_AUDIT_DIGEST_USERS` env CSV into a normalized lower-case
 * Set of user names. Whitespace per token is trimmed; empty tokens dropped;
 * unset / blank / "no real entries" returns `undefined` (= unfiltered /
 * fleet-wide). Pure — exported for tests.
 *
 * Examples:
 *   "alice,bob"          → Set{ "alice", "bob" }
 *   " Alice , BOB "      → Set{ "alice", "bob" }   (trim + lowercase)
 *   ",,, "               → undefined               (no real entries → fleet-wide)
 *   undefined / ""       → undefined               (env unset → fleet-wide)
 */
export function parseAuditDigestUserFilter(
  raw: string | undefined,
): Set<string> | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  const names = trimmed
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  if (names.length === 0) return undefined;
  return new Set(names);
}

/**
 * Apply the user filter from `parseAuditDigestUserFilter` to a row list.
 * `undefined` filter → identity (fleet-wide). Match is case-insensitive on
 * `user_name`. Pure — exported for tests.
 */
export function filterAuditRowsByUsers(
  rows: BriefingSectionsAuditRow[],
  filter: Set<string> | undefined,
): BriefingSectionsAuditRow[] {
  if (filter === undefined) return rows;
  return rows.filter((r) => filter.has((r.user_name ?? '').toLowerCase()));
}

/**
 * Top-level entry point for the daily 7 AM CT scheduler. Reads audit rows
 * from the trailing 24h, renders a digest, and returns it. Empty case →
 * `{ ran: false, message: null, reason: 'empty' }`. Opt-out via
 * `DISABLE_BRIEFING_AUDIT_DIGEST=1`.
 *
 * Polish 7 (2026-04-29): when `BRIEFING_AUDIT_DIGEST_USERS=alice,bob` is set,
 * the digest is scoped to those users (case-insensitive `user_name` match).
 * Empty CSV after split → unfiltered (fleet-wide). Unset → unfiltered.
 */
export function runBriefingSectionsAuditDigest(
  db: Database.Database,
  deps: AuditDigestDeps = {},
): RunAuditDigestResult {
  const env = deps.env ?? (process.env as Record<string, string | undefined>);
  if (env.DISABLE_BRIEFING_AUDIT_DIGEST === '1') {
    return { ran: false, rowCount: 0, message: null, reason: 'disabled' };
  }
  const now = deps.now ? deps.now() : new Date();
  const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const allRows = getBriefingSectionsAuditSince(db, cutoff);
  const userFilter = parseAuditDigestUserFilter(env.BRIEFING_AUDIT_DIGEST_USERS);
  const rows = filterAuditRowsByUsers(allRows, userFilter);
  const message = formatBriefingSectionsAuditDigest(rows, 24);
  if (message === null) {
    return { ran: false, rowCount: 0, message: null, reason: 'empty' };
  }
  return { ran: true, rowCount: rows.length, message, reason: 'sent' };
}
