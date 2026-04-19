import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import { createUser } from '../../src/db/user-queries.js';
import {
  processPendingInvites,
  formatOnboardingSummary,
  type PendingInviteEntry,
} from '../../src/onboarding/pending-invites.js';

function makeTempManifest(entries: PendingInviteEntry[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcsec-onboarding-'));
  const file = path.join(dir, 'pending_invites.json');
  fs.writeFileSync(file, JSON.stringify(entries, null, 2));
  return file;
}

describe('processPendingInvites', () => {
  let db: Database.Database;
  let logs: string[];

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
    logs = [];
    createUser(db, {
      id: 'olivier',
      name: 'Olivier',
      email: 'olivier@dearborndenim.com',
      role: 'member',
    });
    createUser(db, {
      id: 'merab',
      name: 'Merab',
      email: 'merab@dearborndenim.com',
      role: 'member',
    });
  });

  afterEach(() => {
    db.close();
  });

  it('mints an invite for each pending entry and stubs email via stdout when unconfigured', async () => {
    const manifest = makeTempManifest([
      { email: 'olivier@dearborndenim.com', name: 'Olivier' },
      { email: 'merab@dearborndenim.com', name: 'Merab' },
    ]);

    const result = await processPendingInvites(db, {
      manifestPath: manifest,
      sendInviteEmailDeps: {
        env: {},
        logger: (line) => logs.push(line),
      },
      now: () => '2026-04-18T00:00:00Z',
    });

    expect(result.processed).toHaveLength(2);
    expect(result.processed[0]!.status).toBe('stubbed');
    expect(result.processed[0]!.code).toBeDefined();
    expect(result.processed[0]!.transport).toBe('stdout');
    expect(result.processed[1]!.status).toBe('stubbed');

    // Stdout logger fired once per invitee.
    expect(logs).toHaveLength(2);

    // Manifest is rewritten with onboarded_at stamps.
    const rewritten = JSON.parse(fs.readFileSync(manifest, 'utf8')) as PendingInviteEntry[];
    expect(rewritten[0]!.onboarded_at).toBe('2026-04-18T00:00:00Z');
    expect(rewritten[1]!.onboarded_at).toBe('2026-04-18T00:00:00Z');
  });

  it('skips entries that already have onboarded_at set (idempotent reruns)', async () => {
    const manifest = makeTempManifest([
      {
        email: 'olivier@dearborndenim.com',
        name: 'Olivier',
        onboarded_at: '2026-04-17T00:00:00Z',
      },
      { email: 'merab@dearborndenim.com', name: 'Merab' },
    ]);

    const result = await processPendingInvites(db, {
      manifestPath: manifest,
      sendInviteEmailDeps: { env: {}, logger: (line) => logs.push(line) },
      now: () => '2026-04-18T00:00:00Z',
    });

    expect(result.processed).toHaveLength(2);
    expect(result.processed[0]!.status).toBe('already_onboarded');
    expect(result.processed[1]!.status).toBe('stubbed');

    // Olivier's onboarded_at is preserved from the prior run.
    const rewritten = JSON.parse(fs.readFileSync(manifest, 'utf8')) as PendingInviteEntry[];
    expect(rewritten[0]!.onboarded_at).toBe('2026-04-17T00:00:00Z');
    expect(rewritten[1]!.onboarded_at).toBe('2026-04-18T00:00:00Z');
  });

  it('reports user_not_found for entries with no matching user row', async () => {
    const manifest = makeTempManifest([
      { email: 'nobody@example.com', name: 'Nobody' },
    ]);

    const result = await processPendingInvites(db, {
      manifestPath: manifest,
      sendInviteEmailDeps: { env: {}, logger: (line) => logs.push(line) },
    });

    expect(result.processed[0]!.status).toBe('user_not_found');
    expect(result.processed[0]!.error).toContain('No user row');

    // Manifest entry is NOT stamped onboarded_at (admin should fix + retry).
    const rewritten = JSON.parse(fs.readFileSync(manifest, 'utf8')) as PendingInviteEntry[];
    expect(rewritten[0]!.onboarded_at).toBeUndefined();
  });

  it('reports email_failed when Graph returns an error and does not stamp onboarded_at', async () => {
    const manifest = makeTempManifest([
      { email: 'olivier@dearborndenim.com', name: 'Olivier' },
    ]);

    const result = await processPendingInvites(db, {
      manifestPath: manifest,
      sendInviteEmailDeps: {
        env: { INVITE_SENDER_EMAIL: 'rob@dearborndenim.com' },
        getGraphToken: async () => 'tok',
        fetchImpl: (async () => ({
          ok: false,
          status: 500,
          statusText: 'Server Error',
          text: async () => '',
        })) as unknown as typeof fetch,
      },
      now: () => '2026-04-18T00:00:00Z',
    });

    expect(result.processed[0]!.status).toBe('email_failed');
    expect(result.processed[0]!.code).toBeDefined();
    expect(result.processed[0]!.error).toContain('500');

    const rewritten = JSON.parse(fs.readFileSync(manifest, 'utf8')) as PendingInviteEntry[];
    expect(rewritten[0]!.onboarded_at).toBeUndefined();
  });

  it('returns manifestMissing when pending_invites.json does not exist', async () => {
    const result = await processPendingInvites(db, {
      manifestPath: path.join(os.tmpdir(), 'nonexistent-manifest-xyz.json'),
    });
    expect(result.manifestMissing).toBe(true);
    expect(result.processed).toHaveLength(0);
  });

  it('handles empty array manifest gracefully', async () => {
    const manifest = makeTempManifest([]);
    const result = await processPendingInvites(db, {
      manifestPath: manifest,
      sendInviteEmailDeps: { env: {}, logger: () => {} },
    });
    expect(result.manifestMissing).toBeFalsy();
    expect(result.processed).toHaveLength(0);
  });

  it('normalizes invitee email to lowercase before DB lookup', async () => {
    const manifest = makeTempManifest([
      { email: 'Olivier@DearBornDenim.com', name: 'Olivier' },
    ]);
    const result = await processPendingInvites(db, {
      manifestPath: manifest,
      sendInviteEmailDeps: { env: {}, logger: () => {} },
      now: () => '2026-04-18T00:00:00Z',
    });
    expect(result.processed[0]!.status).toBe('stubbed');
  });

  it('throws a helpful error when the manifest is not a JSON array', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcsec-onboarding-bad-'));
    const file = path.join(dir, 'pending_invites.json');
    fs.writeFileSync(file, JSON.stringify({ email: 'x@x.com' }));

    await expect(
      processPendingInvites(db, {
        manifestPath: file,
        sendInviteEmailDeps: { env: {}, logger: () => {} },
      }),
    ).rejects.toThrow(/must be an array/);
  });
});

describe('formatOnboardingSummary', () => {
  it('formats a mixed-outcome summary with totals', () => {
    const text = formatOnboardingSummary({
      processed: [
        { email: 'a@x.com', name: 'A', status: 'sent', code: 'abc' },
        { email: 'b@x.com', name: 'B', status: 'stubbed', code: 'def' },
        { email: 'c@x.com', name: 'C', status: 'already_onboarded' },
        { email: 'd@x.com', name: 'D', status: 'user_not_found' },
        { email: 'e@x.com', name: 'E', status: 'email_failed', code: 'xyz', error: '500' },
      ],
    });

    expect(text).toContain('Bulk onboarding summary');
    expect(text).toContain('A — emailed code abc');
    expect(text).toContain('B — stubbed');
    expect(text).toContain('C — already onboarded');
    expect(text).toContain('D — no user row');
    expect(text).toContain('E — code xyz minted but email failed');
    expect(text).toContain('sent=1');
    expect(text).toContain('stubbed=1');
    expect(text).toContain('skipped=1');
    expect(text).toContain('failed=2');
  });

  it('reports manifest missing', () => {
    const text = formatOnboardingSummary({ processed: [], manifestMissing: true });
    expect(text).toContain('No pending_invites.json');
  });

  it('reports empty manifest', () => {
    const text = formatOnboardingSummary({ processed: [] });
    expect(text).toContain('empty');
  });
});
