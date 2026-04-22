/**
 * `/onboarding-status` Telegram admin command renderer.
 *
 * Reads `pending_invites.json` and emits a single Telegram message summarizing
 * which invitees are still pending (no `onboarded_at`) vs already onboarded
 * (has `onboarded_at`). Each section is capped at `MAX_PER_SECTION` entries;
 * additional rows are summarized as `…and N older truncated`.
 *
 * Kept as a pure formatter + thin IO wrapper so the renderer is straightforward
 * to unit-test without touching the filesystem. The handler in index.ts just
 * reads the manifest and calls `renderOnboardingStatus` with the array.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { PendingInviteEntry } from './pending-invites.js';

export const MAX_PER_SECTION = 20;

export interface OnboardingStatusInput {
  entries: PendingInviteEntry[];
  /** Absolute path for error messaging when the manifest is missing. */
  manifestPath: string;
  /** Whether the manifest existed on disk (lets us report "missing"). */
  manifestMissing?: boolean;
  /**
   * When true, the Onboarded section is suppressed entirely. Pending section
   * still renders with counts, truncation, and "- none" when empty. Used by
   * the `/onboarding-status --pending-only` admin flag.
   */
  pendingOnly?: boolean;
}

/**
 * Parsed form of the `/onboarding-status [--pending-only]` Telegram command.
 */
export interface ParsedOnboardingStatusCommand {
  matched: boolean;
  pendingOnly: boolean;
}

/**
 * Parse the raw Telegram text into a structured onboarding-status command.
 * Returns `{ matched: false, pendingOnly: false }` for anything that isn't
 * the bare command or the `--pending-only` form. Unknown flags are strictly
 * rejected so accidental typos don't silently fall through to "show all".
 */
export function parseOnboardingStatusCommand(raw: string): ParsedOnboardingStatusCommand {
  const trimmed = raw.trim();
  if (/^\/onboarding-status$/i.test(trimmed)) {
    return { matched: true, pendingOnly: false };
  }
  if (/^\/onboarding-status\s+--pending-only$/i.test(trimmed)) {
    return { matched: true, pendingOnly: true };
  }
  return { matched: false, pendingOnly: false };
}

function formatTimestamp(ts: string | null | undefined): string {
  if (!ts) return '—';
  // Best-effort: use the ISO prefix up to the minute. Telegram messages render
  // raw strings, so we avoid locale-based formatting that varies by runtime.
  const match = ts.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  if (match) return `${match[1]} ${match[2]}Z`;
  return ts;
}

function describeRole(entry: PendingInviteEntry): string {
  return entry.role ?? 'staff';
}

/**
 * Pure formatter. Returns the message string for Telegram delivery.
 */
export function renderOnboardingStatus(input: OnboardingStatusInput): string {
  if (input.manifestMissing) {
    return `No pending_invites.json found at ${input.manifestPath}.`;
  }

  // Empty manifest is a distinct case from "no pending" — the file exists
  // but has zero rows. When pendingOnly is set we still want to show the
  // "Pending (0)" rollup so the admin has explicit feedback, so only emit
  // the "empty" short-circuit when rendering the full (default) view.
  if (input.entries.length === 0 && !input.pendingOnly) {
    return 'pending_invites.json is empty.';
  }

  const pending = input.entries.filter((e) => !e.onboarded_at);
  const onboarded = input.entries.filter((e) => !!e.onboarded_at);

  const lines: string[] = [];
  lines.push('Onboarding status:');
  lines.push('');

  // Pending section — oldest invited_at first so stale invites surface.
  const pendingSorted = [...pending].sort((a, b) =>
    (a.invited_at ?? '').localeCompare(b.invited_at ?? ''),
  );
  lines.push(`Pending (${pending.length}):`);
  if (pending.length === 0) {
    lines.push('- none');
  } else {
    const shown = pendingSorted.slice(0, MAX_PER_SECTION);
    for (const e of shown) {
      const invited = formatTimestamp(e.invited_at);
      const reminded = e.reminder_sent_at ? ` reminded=${formatTimestamp(e.reminder_sent_at)}` : '';
      lines.push(
        `- ${e.name} <${e.email}> (${describeRole(e)}) invited=${invited}${reminded}`,
      );
    }
    const truncated = pendingSorted.length - shown.length;
    if (truncated > 0) {
      lines.push(`…and ${truncated} older truncated`);
    }
  }

  // Onboarded section — suppressed entirely when pendingOnly is set.
  if (!input.pendingOnly) {
    lines.push('');
    const onboardedSorted = [...onboarded].sort((a, b) =>
      (b.onboarded_at ?? '').localeCompare(a.onboarded_at ?? ''),
    );
    lines.push(`Onboarded (${onboarded.length}):`);
    if (onboarded.length === 0) {
      lines.push('- none');
    } else {
      const shown = onboardedSorted.slice(0, MAX_PER_SECTION);
      for (const e of shown) {
        const ts = formatTimestamp(e.onboarded_at);
        lines.push(`- ${e.name} <${e.email}> (${describeRole(e)}) onboarded=${ts}`);
      }
      const truncated = onboardedSorted.length - shown.length;
      if (truncated > 0) {
        lines.push(`…and ${truncated} older truncated`);
      }
    }
  }

  return lines.join('\n');
}

/**
 * Load the manifest from disk and render the status string. Used by the
 * Telegram handler in index.ts. Errors reading JSON are surfaced in the
 * output rather than thrown.
 */
export function readAndRenderOnboardingStatus(
  manifestPath: string,
  opts: { pendingOnly?: boolean } = {},
): string {
  if (!fs.existsSync(manifestPath)) {
    return renderOnboardingStatus({
      entries: [],
      manifestPath,
      manifestMissing: true,
      pendingOnly: opts.pendingOnly,
    });
  }
  try {
    const raw = fs.readFileSync(manifestPath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return `pending_invites.json at ${manifestPath} is not a JSON array.`;
    }
    return renderOnboardingStatus({
      entries: parsed as PendingInviteEntry[],
      manifestPath,
      pendingOnly: opts.pendingOnly,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Failed to read pending_invites.json: ${msg}`;
  }
}

/** Default manifest location (mirrors `defaultManifestPath` in pending-invites.ts). */
export function defaultStatusManifestPath(): string {
  return path.resolve(process.cwd(), 'pending_invites.json');
}

/**
 * Update the manifest entry matching `email` to stamp `started_at = <iso>`.
 * No-op if the manifest is missing or the entry is not present. Exists so the
 * `/start <code>` handler can mark an invitee as "linked" for the reminder
 * job's state machine without coupling the bot handler to file IO details.
 */
export function stampStartedAt(
  manifestPath: string,
  email: string,
  now: () => string = () => new Date().toISOString(),
): boolean {
  if (!fs.existsSync(manifestPath)) return false;
  const raw = fs.readFileSync(manifestPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!Array.isArray(parsed)) return false;
  const entries = parsed as PendingInviteEntry[];
  const target = entries.find(
    (e) => e.email.toLowerCase() === email.toLowerCase(),
  );
  if (!target) return false;
  if (target.started_at) return false; // idempotent
  target.started_at = now();
  fs.writeFileSync(manifestPath, JSON.stringify(entries, null, 2) + '\n', 'utf8');
  return true;
}
