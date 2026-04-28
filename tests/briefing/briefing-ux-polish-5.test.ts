/**
 * Briefing UX polish 5 — 2026-04-27.
 *
 * Three sub-features on top of /briefing-sections:
 *   1. --revert --to=<audit-id>  → revert to a specific historical audit row
 *   2. Briefing-audit digest extends per-action breakdown w/ revert + summary
 *   3. Per-user revert-spike alert (count > N in 24h, 12h cooldown)
 *
 * Tests cover parser changes for --to, audit-id validation, source_user
 * audit:<id> trail, digest action breakdown formatting, and revert-alert
 * threshold + cooldown.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import {
  createUser,
  insertBriefingSectionsAudit,
  getBriefingSectionsAuditById,
  getBriefingSectionsAuditForUserSince,
  type BriefingSectionsAuditRow,
} from '../../src/db/user-queries.js';
import { parseBriefingSectionsCommand } from '../../src/briefing/sections-command.js';
import { formatBriefingSectionsAuditDigest } from '../../src/briefing/sections-audit-digest.js';
import {
  maybeFireRevertAlert,
  _resetRevertAlertCooldownForTesting,
} from '../../src/briefing/revert-alert.js';

// ============================================================================
// Parser — --revert --to=<audit-id>
// ============================================================================
describe('Polish 5 — parser: --revert --to=<id>', () => {
  it('parses --revert --to=42', () => {
    const a = parseBriefingSectionsCommand(
      '/briefing-sections --user=Olivier --revert --to=42',
    );
    expect(a.matched).toBe(true);
    expect(a.revert).toBe(true);
    expect(a.revertTo).toBe(42);
  });

  it('rejects --to without --revert', () => {
    expect(
      parseBriefingSectionsCommand(
        '/briefing-sections --user=Olivier --to=42',
      ).matched,
    ).toBe(false);
    expect(
      parseBriefingSectionsCommand(
        '/briefing-sections --user=Olivier --reset --to=42',
      ).matched,
    ).toBe(false);
  });

  it('rejects --to with non-numeric value', () => {
    expect(
      parseBriefingSectionsCommand(
        '/briefing-sections --user=Olivier --revert --to=abc',
      ).matched,
    ).toBe(false);
    expect(
      parseBriefingSectionsCommand(
        '/briefing-sections --user=Olivier --revert --to=-5',
      ).matched,
    ).toBe(false);
    expect(
      parseBriefingSectionsCommand(
        '/briefing-sections --user=Olivier --revert --to=0',
      ).matched,
    ).toBe(false);
  });

  it('bare --revert (no --to) still works (Polish 4 behavior)', () => {
    const a = parseBriefingSectionsCommand(
      '/briefing-sections --user=Olivier --revert',
    );
    expect(a.matched).toBe(true);
    expect(a.revert).toBe(true);
    expect(a.revertTo).toBeUndefined();
  });
});

// ============================================================================
// getBriefingSectionsAuditById — DB lookup helper
// ============================================================================
describe('Polish 5 — getBriefingSectionsAuditById', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
    createUser(db, { id: 'oli', name: 'Olivier', email: 'oli@x.com', role: 'member' });
  });

  it('returns the row when id exists', () => {
    insertBriefingSectionsAudit(db, {
      user_name: 'Olivier',
      action: 'set',
      sections_json: JSON.stringify(['calendar', 'emails']),
    });
    insertBriefingSectionsAudit(db, {
      user_name: 'Olivier',
      action: 'reset',
      sections_json: null,
    });

    const allRows = getBriefingSectionsAuditForUserSince(
      db,
      'Olivier',
      '2000-01-01T00:00:00Z',
    );
    expect(allRows).toHaveLength(2);

    const lookup = getBriefingSectionsAuditById(db, allRows[0]!.id);
    expect(lookup).toBeDefined();
    expect(lookup?.user_name).toBe('Olivier');
    expect(lookup?.action).toBe(allRows[0]!.action);
  });

  it('returns undefined for missing id', () => {
    expect(getBriefingSectionsAuditById(db, 999_999)).toBeUndefined();
  });
});

// ============================================================================
// Digest — per-action breakdown summary line
// ============================================================================
describe('Polish 5 — digest action breakdown', () => {
  function row(
    action: BriefingSectionsAuditRow['action'],
    user: string,
    sections: string[] | null = null,
  ): BriefingSectionsAuditRow {
    return {
      id: Math.floor(Math.random() * 1_000_000),
      ts: '2026-04-26T08:00:00Z',
      user_name: user,
      action,
      source_user: null,
      sections_json: sections === null ? null : JSON.stringify(sections),
      actor: 'admin',
    };
  }

  it('includes a "By action: ..." summary line when rows are present', () => {
    const rows: BriefingSectionsAuditRow[] = [
      row('set', 'Olivier', ['calendar']),
      row('set', 'Merab', ['emails']),
      row('revert', 'Olivier'),
      row('reset', 'Merab'),
    ];
    const text = formatBriefingSectionsAuditDigest(rows, 24);
    expect(text).not.toBeNull();
    expect(text).toContain('By action:');
    expect(text).toContain('set=2');
    expect(text).toContain('reset=1');
    expect(text).toContain('revert=1');
  });

  it('suppresses zero-count action groups in the summary', () => {
    const rows: BriefingSectionsAuditRow[] = [
      row('revert', 'Olivier'),
    ];
    const text = formatBriefingSectionsAuditDigest(rows, 24);
    expect(text).toContain('By action:');
    expect(text).toContain('revert=1');
    expect(text).not.toContain('set=');
    expect(text).not.toContain('reset=');
    expect(text).not.toContain('clone-from=');
  });

  it('renders revert lines with "(revert ...)" breadcrumb', () => {
    const rows: BriefingSectionsAuditRow[] = [
      {
        id: 7,
        ts: '2026-04-26T08:00:00Z',
        user_name: 'Olivier',
        action: 'revert',
        source_user: 'audit:5',
        sections_json: JSON.stringify(['calendar']),
        actor: 'admin',
      },
    ];
    const text = formatBriefingSectionsAuditDigest(rows, 24);
    expect(text).toContain('(revert audit:5)');
  });

  it('returns null when rows is empty (preserves Polish 3 behavior)', () => {
    expect(formatBriefingSectionsAuditDigest([], 24)).toBeNull();
  });
});

// ============================================================================
// Revert-spike alert — threshold + cooldown
// ============================================================================
describe('Polish 5 — maybeFireRevertAlert', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
    createUser(db, { id: 'oli', name: 'Olivier', email: 'oli@x.com', role: 'member' });
    _resetRevertAlertCooldownForTesting();
  });

  function seedReverts(count: number, baseDate: Date) {
    for (let i = 0; i < count; i++) {
      const ts = new Date(baseDate.getTime() - i * 60_000).toISOString();
      insertBriefingSectionsAudit(db, {
        ts,
        user_name: 'Olivier',
        action: 'revert',
        sections_json: null,
      });
    }
  }

  it('does not fire when count <= threshold', async () => {
    const now = new Date('2026-04-27T12:00:00Z');
    seedReverts(2, now); // threshold default = 3
    const result = await maybeFireRevertAlert(db, 'Olivier', {
      now: () => now,
      env: {},
      console: { log: () => {}, error: () => {} },
    });
    expect(result.fired).toBe(false);
    expect(result.reason).toBe('below_threshold');
    expect(result.count).toBe(2);
  });

  it('fires when count > threshold and runs sendMessage', async () => {
    const now = new Date('2026-04-27T12:00:00Z');
    seedReverts(4, now);
    const sent: string[] = [];
    const result = await maybeFireRevertAlert(db, 'Olivier', {
      now: () => now,
      env: {},
      sendMessage: async (text) => {
        sent.push(text);
      },
      console: { log: () => {}, error: () => {} },
    });
    expect(result.fired).toBe(true);
    expect(result.count).toBe(4);
    expect(result.threshold).toBe(3);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('Olivier');
    expect(sent[0]).toContain('4 times');
  });

  it('cooldown blocks a second fire within 12h', async () => {
    const now1 = new Date('2026-04-27T12:00:00Z');
    seedReverts(4, now1);
    await maybeFireRevertAlert(db, 'Olivier', {
      now: () => now1,
      env: {},
      console: { log: () => {}, error: () => {} },
    });
    // 30 min later — still within cooldown.
    const now2 = new Date('2026-04-27T12:30:00Z');
    const result = await maybeFireRevertAlert(db, 'Olivier', {
      now: () => now2,
      env: {},
      console: { log: () => {}, error: () => {} },
    });
    expect(result.fired).toBe(false);
    expect(result.reason).toBe('cooldown');
  });

  it('respects DISABLE_BRIEFING_REVERT_ALERT=1', async () => {
    const now = new Date('2026-04-27T12:00:00Z');
    seedReverts(10, now);
    const result = await maybeFireRevertAlert(db, 'Olivier', {
      now: () => now,
      env: { DISABLE_BRIEFING_REVERT_ALERT: '1' },
      console: { log: () => {}, error: () => {} },
    });
    expect(result.fired).toBe(false);
    expect(result.reason).toBe('disabled');
  });

  it('honours BRIEFING_REVERT_ALERT_THRESHOLD env override', async () => {
    const now = new Date('2026-04-27T12:00:00Z');
    seedReverts(2, now); // 2 reverts
    const result = await maybeFireRevertAlert(db, 'Olivier', {
      now: () => now,
      env: { BRIEFING_REVERT_ALERT_THRESHOLD: '1' },
      console: { log: () => {}, error: () => {} },
    });
    expect(result.fired).toBe(true);
    expect(result.threshold).toBe(1);
  });
});
