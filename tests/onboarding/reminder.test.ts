import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import { createUser } from '../../src/db/user-queries.js';
import {
  runInviteReminders,
  shouldRemind,
  formatReminderSummary,
  REMINDER_THRESHOLD_MS,
} from '../../src/onboarding/reminder.js';
import type { PendingInviteEntry } from '../../src/onboarding/pending-invites.js';

function makeManifest(entries: PendingInviteEntry[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcsec-reminder-'));
  const file = path.join(dir, 'pending_invites.json');
  fs.writeFileSync(file, JSON.stringify(entries, null, 2));
  return file;
}

describe('shouldRemind state machine', () => {
  const now = new Date('2026-04-20T00:00:00Z');

  it('flags entries invited >48h ago with no started_at and no reminder_sent_at', () => {
    const r = shouldRemind(
      { email: 'a@x.com', name: 'A', invited_at: '2026-04-17T00:00:00Z' },
      now,
    );
    expect(r.due).toBe(true);
  });

  it('skips entries invited <48h ago (not due)', () => {
    const r = shouldRemind(
      { email: 'a@x.com', name: 'A', invited_at: '2026-04-19T12:00:00Z' },
      now,
    );
    expect(r).toEqual({ due: false, reason: 'skipped_not_due' });
  });

  it('skips entries where reminder_sent_at is already set', () => {
    const r = shouldRemind(
      {
        email: 'a@x.com',
        name: 'A',
        invited_at: '2026-04-15T00:00:00Z',
        reminder_sent_at: '2026-04-18T00:00:00Z',
      },
      now,
    );
    expect(r).toEqual({ due: false, reason: 'skipped_already_reminded' });
  });

  it('skips entries where started_at is set (invitee already linked)', () => {
    const r = shouldRemind(
      {
        email: 'a@x.com',
        name: 'A',
        invited_at: '2026-04-15T00:00:00Z',
        started_at: '2026-04-16T00:00:00Z',
      },
      now,
    );
    expect(r).toEqual({ due: false, reason: 'skipped_already_started' });
  });

  it('skips entries with no invited_at stamp (admin never ran /onboard-all-pending)', () => {
    const r = shouldRemind({ email: 'a@x.com', name: 'A' }, now);
    expect(r).toEqual({ due: false, reason: 'skipped_not_onboarded' });
  });

  it('uses a 48h threshold exactly', () => {
    // Exactly 48h + 1ms ago → due. 48h - 1ms → not due.
    const invitedDue = new Date(now.getTime() - REMINDER_THRESHOLD_MS - 1).toISOString();
    const invitedNotDue = new Date(now.getTime() - REMINDER_THRESHOLD_MS + 1000).toISOString();
    expect(shouldRemind({ email: 'a@x.com', name: 'A', invited_at: invitedDue }, now).due).toBe(
      true,
    );
    const notDue = shouldRemind(
      { email: 'a@x.com', name: 'A', invited_at: invitedNotDue },
      now,
    );
    expect(notDue.due).toBe(false);
  });
});

describe('runInviteReminders', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
    createUser(db, {
      id: 'olivier',
      name: 'Olivier',
      email: 'olivier@dearborndenim.com',
      role: 'member',
    });
  });

  afterEach(() => {
    db.close();
  });

  it('sends reminder + stamps reminder_sent_at for due entries (stdout stub)', async () => {
    const manifestPath = makeManifest([
      {
        email: 'olivier@dearborndenim.com',
        name: 'Olivier',
        invited_at: '2026-04-10T00:00:00Z',
      },
    ]);

    const result = await runInviteReminders(db, {
      manifestPath,
      now: () => new Date('2026-04-20T00:00:00Z'),
      sendInviteEmailDeps: { env: {}, logger: () => {} },
    });

    expect(result.processed[0]!.status).toBe('reminded_stubbed');
    expect(result.processed[0]!.code).toBeDefined();

    const rewritten = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as PendingInviteEntry[];
    expect(rewritten[0]!.reminder_sent_at).toBe('2026-04-20T00:00:00.000Z');
  });

  it('skips an entry that was already reminded and does NOT re-stamp', async () => {
    const original = '2026-04-18T00:00:00Z';
    const manifestPath = makeManifest([
      {
        email: 'olivier@dearborndenim.com',
        name: 'Olivier',
        invited_at: '2026-04-10T00:00:00Z',
        reminder_sent_at: original,
      },
    ]);

    const result = await runInviteReminders(db, {
      manifestPath,
      now: () => new Date('2026-04-20T00:00:00Z'),
      sendInviteEmailDeps: { env: {}, logger: () => {} },
    });

    expect(result.processed[0]!.status).toBe('skipped_already_reminded');
    const rewritten = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as PendingInviteEntry[];
    // Timestamp unchanged.
    expect(rewritten[0]!.reminder_sent_at).toBe(original);
  });

  it('prefixes the subject with "Reminder: " when resending via Graph', async () => {
    const manifestPath = makeManifest([
      {
        email: 'olivier@dearborndenim.com',
        name: 'Olivier',
        invited_at: '2026-04-10T00:00:00Z',
      },
    ]);
    let observedBody: Record<string, unknown> | null = null;
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      observedBody = JSON.parse(init?.body as string);
      return { ok: true, status: 202, statusText: 'Accepted', text: async () => '' };
    }) as unknown as typeof fetch;

    await runInviteReminders(db, {
      manifestPath,
      now: () => new Date('2026-04-20T00:00:00Z'),
      sendInviteEmailDeps: {
        env: { INVITE_SENDER_EMAIL: 'rob@dearborndenim.com' },
        getGraphToken: async () => 'tok',
        fetchImpl: fakeFetch,
      },
    });

    expect(observedBody).not.toBeNull();
    const msg = (observedBody as { message: { subject: string } }).message;
    expect(msg.subject.startsWith('Reminder: ')).toBe(true);
  });

  it('does NOT stamp reminder_sent_at on email failure', async () => {
    const manifestPath = makeManifest([
      {
        email: 'olivier@dearborndenim.com',
        name: 'Olivier',
        invited_at: '2026-04-10T00:00:00Z',
      },
    ]);
    const failingFetch = (async () => ({
      ok: false,
      status: 500,
      statusText: 'Server Error',
      text: async () => '',
    })) as unknown as typeof fetch;

    const result = await runInviteReminders(db, {
      manifestPath,
      now: () => new Date('2026-04-20T00:00:00Z'),
      sendInviteEmailDeps: {
        env: { INVITE_SENDER_EMAIL: 'rob@dearborndenim.com' },
        getGraphToken: async () => 'tok',
        fetchImpl: failingFetch,
      },
    });

    expect(result.processed[0]!.status).toBe('email_failed');
    const rewritten = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as PendingInviteEntry[];
    expect(rewritten[0]!.reminder_sent_at).toBeUndefined();
  });

  it('skips entry with started_at set (invitee linked via /start)', async () => {
    const manifestPath = makeManifest([
      {
        email: 'olivier@dearborndenim.com',
        name: 'Olivier',
        invited_at: '2026-04-10T00:00:00Z',
        started_at: '2026-04-11T00:00:00Z',
      },
    ]);

    const result = await runInviteReminders(db, {
      manifestPath,
      now: () => new Date('2026-04-20T00:00:00Z'),
      sendInviteEmailDeps: { env: {}, logger: () => {} },
    });

    expect(result.processed[0]!.status).toBe('skipped_already_started');
  });

  it('returns manifestMissing when pending_invites.json does not exist', async () => {
    const r = await runInviteReminders(db, {
      manifestPath: path.join(os.tmpdir(), 'nonexistent-reminder-xyz.json'),
    });
    expect(r.manifestMissing).toBe(true);
  });

  it('summary renders counts correctly', () => {
    const summary = formatReminderSummary({
      processed: [
        { email: 'a@x.com', name: 'A', status: 'reminded' },
        { email: 'b@x.com', name: 'B', status: 'reminded_stubbed' },
        { email: 'c@x.com', name: 'C', status: 'skipped_not_due' },
        { email: 'd@x.com', name: 'D', status: 'email_failed', error: 'boom' },
      ],
    });
    expect(summary).toContain('reminded=1');
    expect(summary).toContain('stubbed=1');
    expect(summary).toContain('skipped=1');
    expect(summary).toContain('failed=1');
  });
});
