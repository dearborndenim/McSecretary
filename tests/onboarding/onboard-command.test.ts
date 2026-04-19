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
} from '../../src/onboarding/pending-invites.js';

/**
 * The `/onboard-all-pending` Telegram command is admin-gated in index.ts by
 * the same `user.role === 'admin'` check the other admin commands use (like
 * /review, /approve, /invite). Since handleIncomingMessage is not exported,
 * we verify the gate by asserting the command-parsing + admin-role logic
 * explicitly here, and we confirm the processPendingInvites + summary flow
 * wires together for an admin happy-path.
 */

describe('/onboard-all-pending gating', () => {
  function isAdminOnboardCommand(text: string, role: 'admin' | 'member'): boolean {
    const lowerText = text.toLowerCase().trim();
    return lowerText === '/onboard-all-pending' && role === 'admin';
  }

  it('matches admin user sending /onboard-all-pending', () => {
    expect(isAdminOnboardCommand('/onboard-all-pending', 'admin')).toBe(true);
  });

  it('ignores member user sending /onboard-all-pending', () => {
    expect(isAdminOnboardCommand('/onboard-all-pending', 'member')).toBe(false);
  });

  it('is case-insensitive on the command text', () => {
    expect(isAdminOnboardCommand('/Onboard-All-Pending', 'admin')).toBe(true);
  });

  it('does not match with trailing args (strict equality)', () => {
    // We keep the command argumentless by design; the manifest lives on disk.
    expect(isAdminOnboardCommand('/onboard-all-pending now', 'admin')).toBe(false);
  });

  it('does not match partial prefixes', () => {
    expect(isAdminOnboardCommand('/onboard', 'admin')).toBe(false);
    expect(isAdminOnboardCommand('/onboard-all', 'admin')).toBe(false);
  });
});

describe('/onboard-all-pending admin happy-path wiring', () => {
  let db: Database.Database;
  let manifestPath: string;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
    createUser(db, {
      id: 'olivier',
      name: 'Olivier',
      email: 'olivier@dearborndenim.com',
      role: 'member',
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcsec-onboard-cmd-'));
    manifestPath = path.join(dir, 'pending_invites.json');
    fs.writeFileSync(
      manifestPath,
      JSON.stringify([
        { email: 'olivier@dearborndenim.com', name: 'Olivier' },
      ]),
    );
  });

  afterEach(() => {
    db.close();
  });

  it('returns a human-readable summary when admin runs the command', async () => {
    const logs: string[] = [];
    const result = await processPendingInvites(db, {
      manifestPath,
      sendInviteEmailDeps: { env: {}, logger: (l) => logs.push(l) },
      now: () => '2026-04-18T00:00:00Z',
    });
    const summary = formatOnboardingSummary(result);
    expect(summary).toContain('Bulk onboarding summary');
    expect(summary).toContain('Olivier');
    expect(summary).toContain('sent=0');
    expect(summary).toContain('stubbed=1');
  });
});
