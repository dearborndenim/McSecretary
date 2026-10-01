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
