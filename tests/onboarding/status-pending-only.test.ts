/**
 * `/onboarding-status --pending-only` — filter flag tests.
 *
 * The base `/onboarding-status` command renders two sections: Pending and
 * Onboarded. The `--pending-only` flag suppresses the Onboarded section so
 * admins can quickly scan still-waiting invitees without scrolling past
 * successfully onboarded ones.
 */

import { describe, it, expect } from 'vitest';
import {
  renderOnboardingStatus,
  parseOnboardingStatusCommand,
} from '../../src/onboarding/status.js';
import type { PendingInviteEntry } from '../../src/onboarding/pending-invites.js';

describe('parseOnboardingStatusCommand', () => {
  it('matches the bare command', () => {
    const parsed = parseOnboardingStatusCommand('/onboarding-status');
    expect(parsed.matched).toBe(true);
    expect(parsed.pendingOnly).toBe(false);
  });

  it('matches --pending-only flag', () => {
    const parsed = parseOnboardingStatusCommand('/onboarding-status --pending-only');
    expect(parsed.matched).toBe(true);
    expect(parsed.pendingOnly).toBe(true);
  });

  it('is case-insensitive', () => {
    const parsed = parseOnboardingStatusCommand('/Onboarding-Status --Pending-Only');
    expect(parsed.matched).toBe(true);
    expect(parsed.pendingOnly).toBe(true);
  });

  it('tolerates surrounding whitespace', () => {
    const parsed = parseOnboardingStatusCommand('  /onboarding-status --pending-only  ');
    expect(parsed.matched).toBe(true);
    expect(parsed.pendingOnly).toBe(true);
  });

  it('does not match unrelated commands', () => {
    expect(parseOnboardingStatusCommand('/onboarding-status-foo').matched).toBe(false);
    expect(parseOnboardingStatusCommand('/onboarding').matched).toBe(false);
  });

  it('rejects unknown flags (strict)', () => {
    // Protects against accidental typos being silently ignored.
    const parsed = parseOnboardingStatusCommand('/onboarding-status --pend');
    expect(parsed.matched).toBe(false);
  });
});

describe('renderOnboardingStatus with pendingOnly=true', () => {
  const entries: PendingInviteEntry[] = [
    { email: 'a@x.com', name: 'A', role: 'staff', invited_at: '2026-04-15T10:00:00Z' },
    { email: 'b@x.com', name: 'B', role: 'admin', invited_at: '2026-04-10T10:00:00Z', onboarded_at: '2026-04-10T10:05:00Z' },
    { email: 'c@x.com', name: 'C', role: 'staff', invited_at: '2026-04-16T09:00:00Z' },
  ];

  it('omits the Onboarded section entirely when pendingOnly=true', () => {
    const text = renderOnboardingStatus({
      entries,
      manifestPath: '/tmp/x.json',
      pendingOnly: true,
    });
    expect(text).toContain('Pending (2):');
    expect(text).not.toContain('Onboarded');
    // A and C are still listed.
    expect(text).toContain('A <a@x.com>');
    expect(text).toContain('C <c@x.com>');
    // B is explicitly excluded from the pending-only output.
    expect(text).not.toContain('B <b@x.com>');
  });

  it('still reports empty when there are zero pending entries', () => {
    const allOnboarded: PendingInviteEntry[] = [
      { email: 'b@x.com', name: 'B', role: 'admin', invited_at: '2026-04-10T10:00:00Z', onboarded_at: '2026-04-10T10:05:00Z' },
    ];
    const text = renderOnboardingStatus({
      entries: allOnboarded,
      manifestPath: '/tmp/x.json',
      pendingOnly: true,
    });
    // Must clearly communicate "no pending" rather than printing nothing.
    expect(text).toContain('Pending (0):');
    expect(text).toContain('- none');
    expect(text).not.toContain('Onboarded');
  });

  it('still reports manifest-missing when pendingOnly is set', () => {
    const text = renderOnboardingStatus({
      entries: [],
      manifestPath: '/missing.json',
      manifestMissing: true,
      pendingOnly: true,
    });
    expect(text).toContain('No pending_invites.json');
  });

  it('default (pendingOnly=false) still shows both sections — no regression', () => {
    const text = renderOnboardingStatus({
      entries,
      manifestPath: '/tmp/x.json',
    });
    expect(text).toContain('Pending (2):');
    expect(text).toContain('Onboarded (1):');
    expect(text).toContain('B <b@x.com>');
  });
});

describe('/onboarding-status --pending-only wiring', () => {
  it('index.ts routes --pending-only into the pendingOnly branch', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const indexPath = path.join(process.cwd(), 'src', 'index.ts');
    const source = fs.readFileSync(indexPath, 'utf-8');
    // Handler uses the parser + calls renderOnboardingStatus (or the read+render helper)
    // with the pending-only flag.
    expect(source).toContain('parseOnboardingStatusCommand');
    expect(source).toMatch(/pendingOnly/);
  });

  it('/onboarding-status handler remains admin-gated', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const indexPath = path.join(process.cwd(), 'src', 'index.ts');
    const source = fs.readFileSync(indexPath, 'utf-8');
    const idx = source.indexOf('parseOnboardingStatusCommand');
    expect(idx).toBeGreaterThan(-1);
    const block = source.slice(Math.max(0, idx - 400), idx + 400);
    expect(block).toContain("user.role === 'admin'");
  });
});
