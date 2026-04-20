/**
 * 48-hour invite reminder job.
 *
 * Iterates `pending_invites.json` and, for each entry where:
 *   - `invited_at` is set and >48h in the past,
 *   - `started_at` is unset (invitee hasn't sent `/start` yet),
 *   - `reminder_sent_at` is unset (no reminder already delivered),
 * re-sends the invite email with a "Reminder:" subject prefix and stamps
 * `reminder_sent_at = now()`. A fresh invite code is minted each time so the
 * invitee always has a usable, non-expired code (7-day TTL).
 *
 * The job is scheduled once per day by `src/scheduler.ts`. It shares the
 * same Graph-backed `sendInviteEmail` transport as the initial invite; email
 * failures are logged but do not stop the batch.
 */

import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { createInvite, getUserByEmail } from '../db/user-queries.js';
import { sendInviteEmail, type SendInviteEmailDeps } from '../email/invite-sender.js';
import type { PendingInviteEntry } from './pending-invites.js';

export const REMINDER_THRESHOLD_MS = 48 * 60 * 60 * 1000;

export type ReminderStatus =
  | 'reminded'
  | 'reminded_stubbed'
  | 'skipped_not_due'
  | 'skipped_already_reminded'
  | 'skipped_already_started'
  | 'skipped_not_onboarded'
  | 'user_not_found'
  | 'email_failed';

export interface ReminderOutcome {
  email: string;
  name: string;
  status: ReminderStatus;
  code?: string;
  error?: string;
}

export interface RunRemindersOptions {
  manifestPath: string;
  now?: () => Date;
  sendInviteEmailDeps?: SendInviteEmailDeps;
}

export interface RunRemindersResult {
  processed: ReminderOutcome[];
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
  fs.writeFileSync(manifestPath, JSON.stringify(entries, null, 2) + '\n', 'utf8');
}

export function defaultReminderManifestPath(): string {
  return path.resolve(process.cwd(), 'pending_invites.json');
}

/**
 * Determine whether an entry should receive a reminder right now.
 * Exported for direct testing of the state machine.
 */
export function shouldRemind(
  entry: PendingInviteEntry,
  now: Date,
  thresholdMs: number = REMINDER_THRESHOLD_MS,
): { due: true } | { due: false; reason: Exclude<ReminderStatus, 'reminded' | 'reminded_stubbed' | 'user_not_found' | 'email_failed'> } {
  // Invite hasn't been sent yet (no onboarded_at/invited_at); reminder job
  // doesn't send first-time invites — admin runs /onboard-all-pending for that.
  if (!entry.invited_at) {
    return { due: false, reason: 'skipped_not_onboarded' };
  }
  if (entry.started_at) {
    return { due: false, reason: 'skipped_already_started' };
  }
  if (entry.reminder_sent_at) {
    return { due: false, reason: 'skipped_already_reminded' };
  }
  const invitedTs = Date.parse(entry.invited_at);
  if (Number.isNaN(invitedTs)) {
    // Can't compute age — treat as not-due so we don't flood invitees with bad data.
    return { due: false, reason: 'skipped_not_due' };
  }
  const ageMs = now.getTime() - invitedTs;
  if (ageMs < thresholdMs) {
    return { due: false, reason: 'skipped_not_due' };
  }
  return { due: true };
}

export async function runInviteReminders(
  db: Database.Database,
  opts: RunRemindersOptions,
): Promise<RunRemindersResult> {
  const entries = readManifest(opts.manifestPath);
  if (entries === null) {
    return { processed: [], manifestMissing: true };
  }

  const now = opts.now ?? (() => new Date());
  const processed: ReminderOutcome[] = [];
  let mutated = false;

  for (const entry of entries) {
    const decision = shouldRemind(entry, now());
    if (!decision.due) {
      processed.push({
        email: entry.email,
        name: entry.name,
        status: decision.reason,
      });
      continue;
    }

    const user = getUserByEmail(db, entry.email.toLowerCase());
    if (!user) {
      processed.push({
        email: entry.email,
        name: entry.name,
        status: 'user_not_found',
        error: `No user row for ${entry.email}`,
      });
      continue;
    }

    const code = createInvite(db, user.id);
    const sendResult = await sendInviteEmail(
      {
        to: entry.email,
        name: entry.name,
        code,
        subjectPrefix: 'Reminder: ',
      },
      opts.sendInviteEmailDeps,
    );

    if (!sendResult.ok) {
      processed.push({
        email: entry.email,
        name: entry.name,
        status: 'email_failed',
        code,
        error: sendResult.error,
      });
      continue;
    }

    entry.reminder_sent_at = now().toISOString();
    mutated = true;
    processed.push({
      email: entry.email,
      name: entry.name,
      status: sendResult.transport === 'graph' ? 'reminded' : 'reminded_stubbed',
      code,
    });
  }

  if (mutated) writeManifest(opts.manifestPath, entries);
  return { processed };
}

export function formatReminderSummary(result: RunRemindersResult): string {
  if (result.manifestMissing) {
    return 'Reminder job: no pending_invites.json found.';
  }
  const counts = {
    reminded: 0,
    stubbed: 0,
    skipped: 0,
    failed: 0,
  };
  for (const p of result.processed) {
    switch (p.status) {
      case 'reminded':
        counts.reminded++;
        break;
      case 'reminded_stubbed':
        counts.stubbed++;
        break;
      case 'user_not_found':
      case 'email_failed':
        counts.failed++;
        break;
      default:
        counts.skipped++;
    }
  }
  return `Reminder job: reminded=${counts.reminded} stubbed=${counts.stubbed} skipped=${counts.skipped} failed=${counts.failed}`;
}
