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
  const groups: Record<string, BriefingSectionsAuditRow[]> = {
    set: [],
    reset: [],
    'set-all': [],
    'clone-from': [],
  };
  for (const row of rows) {
    const bucket = groups[row.action];
    if (bucket) bucket.push(row);
  }

  const lines: string[] = [];
  lines.push(
    `Briefing-sections preference changes in the last ${windowHours}h: ${rows.length}`,
  );
  lines.push('');

  const actionOrder: BriefingSectionsAuditRow['action'][] = [
    'set',
    'reset',
    'set-all',
    'clone-from',
  ];

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
 * Top-level entry point for the daily 7 AM CT scheduler. Reads audit rows
 * from the trailing 24h, renders a digest, and returns it. Empty case →
 * `{ ran: false, message: null, reason: 'empty' }`. Opt-out via
 * `DISABLE_BRIEFING_AUDIT_DIGEST=1`.
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
  const rows = getBriefingSectionsAuditSince(db, cutoff);
  const message = formatBriefingSectionsAuditDigest(rows, 24);
  if (message === null) {
    return { ran: false, rowCount: 0, message: null, reason: 'empty' };
  }
  return { ran: true, rowCount: rows.length, message, reason: 'sent' };
}
