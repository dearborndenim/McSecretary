/**
 * Bulk onboarding: process a `pending_invites.json` manifest at the repo root.
 *
 * File shape (array of pending invitees):
 *   [
 *     { "email": "olivier@dearborndenim.com", "name": "Olivier" },
 *     { "email": "merab@dearborndenim.com",   "name": "Merab" }
 *   ]
 *
 * Per-entry flow:
 *   1. Look up the target user row by email (seeded via seed-team.ts).
 *   2. Mint a fresh invite code via `createInvite(db, userId)`.
 *   3. Email the code to the invitee via `sendInviteEmail` (Graph-backed
 *      when configured, stdout stub otherwise).
 *   4. Mark the entry `onboarded_at = <iso>` in the same file so subsequent
 *      runs are idempotent. Entries with a non-empty `onboarded_at` are
 *      skipped.
 *
 * Idempotency: we update the manifest in-place (adding an `onboarded_at`
 * timestamp) rather than moving entries to a second file. This keeps the
 * manifest human-readable and matches the idiomatic pattern used elsewhere
 * in McSecretary for tracking sync state (e.g. `dev_requests.synced_at`).
 */

import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { createInvite, getUserByEmail } from '../db/user-queries.js';
import { sendInviteEmail, type SendInviteEmailDeps } from '../email/invite-sender.js';

/**
 * Pending-invite role. Admin invitees receive the admin schedule window;
 * staff invitees receive a narrower configurable window (see
 * `STAFF_SCHEDULE_WINDOW_START` / `STAFF_SCHEDULE_WINDOW_END` env vars). An
 * entry without a `role` is treated as `"staff"` for backward compatibility
 * with manifests that pre-date multi-role support.
 */
export type PendingInviteRole = 'admin' | 'staff';

export interface PendingInviteEntry {
  email: string;
  name: string;
  /** Optional role; defaults to `"staff"` when absent. */
  role?: PendingInviteRole;
  /** ISO timestamp the initial invite email was delivered. */
  invited_at?: string | null;
  /** ISO timestamp the invitee ran `/start <code>` (when tracked). */
  started_at?: string | null;
  /** ISO timestamp a reminder email was delivered (prevents duplicate reminders). */
  reminder_sent_at?: string | null;
  /** ISO timestamp the admin ran `/onboard-all-pending` for this entry. */
  onboarded_at?: string | null;
}

export interface ProcessedInvite {
  email: string;
  name: string;
  status: 'sent' | 'stubbed' | 'already_onboarded' | 'user_not_found' | 'email_failed';
  code?: string;
  transport?: 'graph' | 'stdout';
  error?: string;
}

export interface ProcessPendingInvitesOptions {
  /** Absolute path to `pending_invites.json`. Required. */
  manifestPath: string;
  /** Overridable email-sender deps (for tests). */
  sendInviteEmailDeps?: SendInviteEmailDeps;
  /** Overridable clock — defaults to `() => new Date().toISOString()`. */
  now?: () => string;
}

export interface ProcessPendingInvitesResult {
  processed: ProcessedInvite[];
  manifestMissing?: boolean;
}

function readManifest(manifestPath: string): PendingInviteEntry[] | null {
  if (!fs.existsSync(manifestPath)) return null;
  const raw = fs.readFileSync(manifestPath, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(
      `pending_invites.json must be an array at ${manifestPath}, got ${typeof parsed}`,
    );
  }
  return parsed as PendingInviteEntry[];
}

function writeManifest(manifestPath: string, entries: PendingInviteEntry[]): void {
  const serialized = JSON.stringify(entries, null, 2) + '\n';
  fs.writeFileSync(manifestPath, serialized, 'utf8');
}

/**
 * Default manifest location — repo root (two levels up from this file's src/).
 */
export function defaultManifestPath(): string {
  // src/onboarding/pending-invites.ts → <root>/pending_invites.json
  return path.resolve(process.cwd(), 'pending_invites.json');
}

/**
 * Process every unprocessed entry in the manifest. Returns per-entry outcomes
 * and rewrites the manifest with `onboarded_at` stamped on successes.
 */
export async function processPendingInvites(
  db: Database.Database,
  opts: ProcessPendingInvitesOptions,
): Promise<ProcessPendingInvitesResult> {
  const entries = readManifest(opts.manifestPath);
  if (entries === null) {
    return { processed: [], manifestMissing: true };
  }

  const now = opts.now ?? (() => new Date().toISOString());
  const processed: ProcessedInvite[] = [];

  for (const entry of entries) {
    // Skip entries already marked as onboarded.
    if (entry.onboarded_at && entry.onboarded_at.length > 0) {
      processed.push({
        email: entry.email,
        name: entry.name,
        status: 'already_onboarded',
      });
      continue;
    }

    const user = getUserByEmail(db, entry.email.toLowerCase());
    if (!user) {
      processed.push({
        email: entry.email,
        name: entry.name,
        status: 'user_not_found',
        error: `No user row for ${entry.email}. Run seedTeam or admin add-user first.`,
      });
      continue;
    }

    const code = createInvite(db, user.id);
    const sendResult = await sendInviteEmail(
      { to: entry.email, name: entry.name, code },
      opts.sendInviteEmailDeps,
    );

    if (!sendResult.ok) {
      processed.push({
        email: entry.email,
        name: entry.name,
        status: 'email_failed',
        code,
        transport: sendResult.transport,
        error: sendResult.error,
      });
      // Don't stamp onboarded_at on failure — the admin should retry.
      continue;
    }

    const ts = now();
    entry.onboarded_at = ts;
    // Stamp `invited_at` on success so the 48h reminder job has something to
    // compare against. Preserve an existing value if one is already present
    // (e.g. manifest was hand-edited).
    if (!entry.invited_at) entry.invited_at = ts;
    // Default role to "staff" for entries missing one, so downstream consumers
    // (reminder job, status renderer) always see a concrete value.
    if (!entry.role) entry.role = 'staff';
    processed.push({
      email: entry.email,
      name: entry.name,
      status: sendResult.transport === 'graph' ? 'sent' : 'stubbed',
      code,
      transport: sendResult.transport,
    });
  }

  // Persist any onboarded_at stamps we applied.
  writeManifest(opts.manifestPath, entries);

  return { processed };
}

/**
 * Format the processing result as a concise Telegram message. Keeps the
 * surface small so the handler in index.ts can just string-template this.
 */
export function formatOnboardingSummary(result: ProcessPendingInvitesResult): string {
  if (result.manifestMissing) {
    return 'No pending_invites.json found at repo root. Create one with an array of {email, name} entries.';
  }

  if (result.processed.length === 0) {
    return 'pending_invites.json is empty.';
  }

  const lines: string[] = ['Bulk onboarding summary:', ''];
  let sent = 0;
  let stubbed = 0;
  let failed = 0;
  let skipped = 0;

  for (const p of result.processed) {
    const label = p.name || p.email;
    switch (p.status) {
      case 'sent':
        lines.push(`✓ ${label} — emailed code ${p.code}`);
        sent++;
        break;
      case 'stubbed':
        lines.push(`· ${label} — stubbed (stdout) code ${p.code}`);
        stubbed++;
        break;
      case 'already_onboarded':
        lines.push(`· ${label} — already onboarded, skipped`);
        skipped++;
        break;
      case 'user_not_found':
        lines.push(`✗ ${label} — no user row for ${p.email}`);
        failed++;
        break;
      case 'email_failed':
        lines.push(`✗ ${label} — code ${p.code} minted but email failed: ${p.error ?? 'unknown'}`);
        failed++;
        break;
    }
  }

  lines.push('');
  lines.push(`Totals: sent=${sent} stubbed=${stubbed} skipped=${skipped} failed=${failed}`);
  return lines.join('\n');
}
