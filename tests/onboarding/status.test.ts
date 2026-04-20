import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  renderOnboardingStatus,
  readAndRenderOnboardingStatus,
  stampStartedAt,
  MAX_PER_SECTION,
} from '../../src/onboarding/status.js';
import type { PendingInviteEntry } from '../../src/onboarding/pending-invites.js';

function tmpManifest(entries: PendingInviteEntry[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcsec-status-'));
  const file = path.join(dir, 'pending_invites.json');
  fs.writeFileSync(file, JSON.stringify(entries, null, 2));
  return file;
}

describe('/onboarding-status rendering', () => {
  it('separates pending from onboarded and shows per-section totals', () => {
    const entries: PendingInviteEntry[] = [
      { email: 'a@x.com', name: 'A', role: 'staff', invited_at: '2026-04-15T10:00:00Z' },
      { email: 'b@x.com', name: 'B', role: 'admin', invited_at: '2026-04-10T10:00:00Z', onboarded_at: '2026-04-10T10:05:00Z' },
      { email: 'c@x.com', name: 'C', role: 'staff', invited_at: '2026-04-16T09:00:00Z', reminder_sent_at: '2026-04-18T09:00:00Z' },
    ];
    const text = renderOnboardingStatus({ entries, manifestPath: '/tmp/x.json' });
    expect(text).toContain('Onboarding status');
    expect(text).toContain('Pending (2):');
    expect(text).toContain('Onboarded (1):');
    // Pending section lists A + C with role + invited_at timestamp rendered.
    expect(text).toContain('A <a@x.com> (staff)');
    expect(text).toContain('C <c@x.com> (staff)');
    // Reminder timestamp shown when present.
    expect(text).toContain('reminded=');
    // Onboarded section lists B with its onboarded timestamp + role.
    expect(text).toContain('B <b@x.com> (admin) onboarded=');
  });

  it('truncates older entries beyond MAX_PER_SECTION in each section', () => {
    // Build 25 pending + 25 onboarded entries.
    const entries: PendingInviteEntry[] = [];
    for (let i = 0; i < 25; i++) {
      entries.push({
        email: `p${i}@x.com`,
        name: `P${i}`,
        invited_at: `2026-04-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
      });
      entries.push({
        email: `o${i}@x.com`,
        name: `O${i}`,
        invited_at: `2026-04-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
        onboarded_at: `2026-04-${String(i + 1).padStart(2, '0')}T00:05:00Z`,
      });
    }
    const text = renderOnboardingStatus({ entries, manifestPath: '/tmp/x.json' });
    // Totals still reflect the full counts, even when truncated in the body.
    expect(text).toContain('Pending (25):');
    expect(text).toContain('Onboarded (25):');
    // Truncation footer appears for both sections (25 - 20 = 5).
    const truncatedCount = (text.match(/…and 5 older truncated/g) ?? []).length;
    expect(truncatedCount).toBe(2);
    // Confirms the cap is actually MAX_PER_SECTION entries per section.
    const pLines = text.split('\n').filter((l) => /^- P\d+ </.test(l));
    expect(pLines.length).toBe(MAX_PER_SECTION);
  });

  it('reports "manifest missing" when flag is set', () => {
    const text = renderOnboardingStatus({
      entries: [],
      manifestPath: '/does/not/exist.json',
      manifestMissing: true,
    });
    expect(text).toContain('No pending_invites.json');
  });

  it('reports empty manifest with a friendly message', () => {
    const text = renderOnboardingStatus({ entries: [], manifestPath: '/tmp/x.json' });
    expect(text).toContain('empty');
  });

  it('treats entries with no role as "staff"', () => {
    const text = renderOnboardingStatus({
      entries: [{ email: 'x@y.com', name: 'X', invited_at: '2026-04-18T00:00:00Z' }],
      manifestPath: '/tmp/x.json',
    });
    expect(text).toContain('(staff)');
  });
});

describe('readAndRenderOnboardingStatus', () => {
  it('renders status from a manifest on disk', () => {
    const file = tmpManifest([
      { email: 'a@x.com', name: 'A', invited_at: '2026-04-18T00:00:00Z' },
    ]);
    const text = readAndRenderOnboardingStatus(file);
    expect(text).toContain('Pending (1):');
    expect(text).toContain('A <a@x.com>');
  });

  it('surfaces manifest-missing when the file does not exist', () => {
    const text = readAndRenderOnboardingStatus(path.join(os.tmpdir(), 'nope-xyz-abc.json'));
    expect(text).toContain('No pending_invites.json');
  });
});

describe('stampStartedAt', () => {
  let manifestPath: string;

  beforeEach(() => {
    manifestPath = tmpManifest([
      { email: 'olivier@dearborndenim.com', name: 'Olivier', invited_at: '2026-04-17T00:00:00Z' },
    ]);
  });

  afterEach(() => {
    // Nothing — tmpdirs will be reaped by OS.
  });

  it('stamps started_at on the matching entry (case-insensitive email match)', () => {
    const stamped = stampStartedAt(
      manifestPath,
      'Olivier@DearBornDenim.com',
      () => '2026-04-18T00:00:00Z',
    );
    expect(stamped).toBe(true);
    const rewritten = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as PendingInviteEntry[];
    expect(rewritten[0]!.started_at).toBe('2026-04-18T00:00:00Z');
  });

  it('is idempotent — does not overwrite an existing started_at', () => {
    // First call stamps.
    stampStartedAt(manifestPath, 'olivier@dearborndenim.com', () => '2026-04-18T00:00:00Z');
    // Second call returns false and preserves the original timestamp.
    const stamped = stampStartedAt(
      manifestPath,
      'olivier@dearborndenim.com',
      () => '2026-04-19T00:00:00Z',
    );
    expect(stamped).toBe(false);
    const rewritten = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as PendingInviteEntry[];
    expect(rewritten[0]!.started_at).toBe('2026-04-18T00:00:00Z');
  });

  it('returns false when no matching entry exists', () => {
    const stamped = stampStartedAt(manifestPath, 'nobody@example.com');
    expect(stamped).toBe(false);
  });

  it('returns false when manifest is missing', () => {
    const stamped = stampStartedAt(path.join(os.tmpdir(), 'nope-xyz.json'), 'a@x.com');
    expect(stamped).toBe(false);
  });
});
