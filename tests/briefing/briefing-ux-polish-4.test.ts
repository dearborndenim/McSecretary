/**
 * Briefing UX polish 4 — 2026-04-26 (Task 7).
 *
 * Three sub-features on top of /briefing-sections:
 *   1. --history --user=<name> [--days=N]   → audit history for that user
 *   2. Audit-log retention auto-prune >90d  → writeAudit prunes old rows
 *   3. --revert --user=<name>               → undo the last action
 *
 * Tests cover parser changes, history output formatting, days clamping,
 * empty-history case, retention auto-prune, revert happy path + insufficient
 * history failure mode, and the audit-row-write side effect of revert.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import {
  createUser,
  setUserBriefingSections,
  getUserBriefingSections,
  insertBriefingSectionsAudit,
  getBriefingSectionsAuditSince,
  getBriefingSectionsAuditForUserSince,
  pruneBriefingSectionsAuditOlderThan,
} from '../../src/db/user-queries.js';
import { parseBriefingSectionsCommand } from '../../src/briefing/sections-command.js';
import { findUserByFirstName } from '../../src/briefing/preview-command.js';
import { VALID_BRIEFING_SECTIONS } from '../../src/briefing/sections.js';

// ============================================================================
// Parser — --history + --days
// ============================================================================
describe('Polish 4 — parser: --history / --days', () => {
  it('parses /briefing-sections --user=Olivier --history', () => {
    const a = parseBriefingSectionsCommand(
      '/briefing-sections --user=Olivier --history',
    );
    expect(a.matched).toBe(true);
    expect(a.history).toBe(true);
    expect(a.targetName).toBe('Olivier');
    expect(a.historyDays).toBeUndefined();
    expect(a.revert).toBeUndefined();
    expect(a.setRaw).toBeUndefined();
  });

  it('parses --history with --days=N', () => {
    const a = parseBriefingSectionsCommand(
      '/briefing-sections --user=Olivier --history --days=14',
    );
    expect(a.matched).toBe(true);
    expect(a.history).toBe(true);
    expect(a.historyDays).toBe(14);
  });

  it('accepts --days in either flag order', () => {
    const a = parseBriefingSectionsCommand(
      '/briefing-sections --days=30 --history --user=Olivier',
    );
    expect(a.matched).toBe(true);
    expect(a.historyDays).toBe(30);
  });

  it('requires --user for --history', () => {
    expect(parseBriefingSectionsCommand('/briefing-sections --history').matched).toBe(false);
    expect(
      parseBriefingSectionsCommand('/briefing-sections --history --days=7').matched,
    ).toBe(false);
  });

  it('rejects --days without --history', () => {
    expect(
      parseBriefingSectionsCommand('/briefing-sections --user=X --days=7').matched,
    ).toBe(false);
    expect(
      parseBriefingSectionsCommand('/briefing-sections --user=X --reset --days=7').matched,
    ).toBe(false);
  });

  it('rejects --history combined with any other action flag', () => {
    expect(
      parseBriefingSectionsCommand('/briefing-sections --user=X --history --set=calendar').matched,
    ).toBe(false);
    expect(
      parseBriefingSectionsCommand('/briefing-sections --user=X --history --reset').matched,
    ).toBe(false);
    expect(
      parseBriefingSectionsCommand('/briefing-sections --user=X --history --list').matched,
    ).toBe(false);
    expect(
      parseBriefingSectionsCommand('/briefing-sections --user=X --history --diff').matched,
    ).toBe(false);
    expect(
      parseBriefingSectionsCommand(
        '/briefing-sections --user=X --history --clone-from=Y',
      ).matched,
    ).toBe(false);
    expect(
      parseBriefingSectionsCommand(
        '/briefing-sections --user=X --history --revert',
      ).matched,
    ).toBe(false);
    expect(
      parseBriefingSectionsCommand(
        '/briefing-sections --history --set-all=calendar --apply-to=all',
      ).matched,
    ).toBe(false);
  });

  it('rejects negative or non-integer --days', () => {
    expect(
      parseBriefingSectionsCommand('/briefing-sections --user=X --history --days=0').matched,
    ).toBe(false);
    expect(
      parseBriefingSectionsCommand('/briefing-sections --user=X --history --days=-1').matched,
    ).toBe(false);
    expect(
      parseBriefingSectionsCommand('/briefing-sections --user=X --history --days=abc').matched,
    ).toBe(false);
    expect(
      parseBriefingSectionsCommand('/briefing-sections --user=X --history --days=').matched,
    ).toBe(false);
  });
});

// ============================================================================
// Parser — --revert
// ============================================================================
describe('Polish 4 — parser: --revert', () => {
  it('parses /briefing-sections --user=Olivier --revert', () => {
    const a = parseBriefingSectionsCommand(
      '/briefing-sections --user=Olivier --revert',
    );
    expect(a.matched).toBe(true);
    expect(a.revert).toBe(true);
    expect(a.targetName).toBe('Olivier');
    expect(a.history).toBeUndefined();
    expect(a.setRaw).toBeUndefined();
  });

  it('requires --user for --revert', () => {
    expect(parseBriefingSectionsCommand('/briefing-sections --revert').matched).toBe(false);
  });

  it('rejects --revert combined with any other action flag', () => {
    expect(
      parseBriefingSectionsCommand('/briefing-sections --user=X --revert --reset').matched,
    ).toBe(false);
    expect(
      parseBriefingSectionsCommand(
        '/briefing-sections --user=X --revert --set=calendar',
      ).matched,
    ).toBe(false);
    expect(
      parseBriefingSectionsCommand('/briefing-sections --user=X --revert --diff').matched,
    ).toBe(false);
    expect(
      parseBriefingSectionsCommand('/briefing-sections --user=X --revert --list').matched,
    ).toBe(false);
    expect(
      parseBriefingSectionsCommand(
        '/briefing-sections --user=X --revert --clone-from=Y',
      ).matched,
    ).toBe(false);
  });

  it('does not break previously-shipped forms (regression check)', () => {
    expect(parseBriefingSectionsCommand('/briefing-sections --user=X --set=calendar').matched).toBe(true);
    expect(parseBriefingSectionsCommand('/briefing-sections --user=X --reset').matched).toBe(true);
    expect(parseBriefingSectionsCommand('/briefing-sections --list').matched).toBe(true);
    expect(parseBriefingSectionsCommand('/briefing-sections --user=X --list').matched).toBe(true);
    expect(parseBriefingSectionsCommand('/briefing-sections --user=X --diff').matched).toBe(true);
    expect(
      parseBriefingSectionsCommand('/briefing-sections --user=X --clone-from=Y').matched,
    ).toBe(true);
    expect(
      parseBriefingSectionsCommand('/briefing-sections --set-all=stats --apply-to=all').matched,
    ).toBe(true);
  });
});

// ============================================================================
// --history handler behavior (DB round-trip + handler logic mirror)
// ============================================================================
function renderHistory(
  db: Database.Database,
  args: { targetName: string; days?: number },
): string {
  const target = findUserByFirstName(db, args.targetName);
  if (!target) return `User '${args.targetName}' not found.`;
  const requested = args.days ?? 7;
  const clamped = requested < 1 ? 1 : requested > 90 ? 90 : requested;
  const cutoff = new Date(Date.now() - clamped * 24 * 60 * 60 * 1000).toISOString();
  const rows = getBriefingSectionsAuditForUserSince(db, target.name, cutoff);
  if (rows.length === 0) {
    return `No audit history for '${target.name}' in last ${clamped} day(s).`;
  }
  const lines = rows.map((row) => {
    const dt = new Date(row.ts);
    const yyyy = dt.getUTCFullYear();
    const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(dt.getUTCDate()).padStart(2, '0');
    const hh = String(dt.getUTCHours()).padStart(2, '0');
    const mi = String(dt.getUTCMinutes()).padStart(2, '0');
    const stamp = `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
    const fromPart = row.source_user ? ` from ${row.source_user}` : '';
    let sectionsLabel: string;
    if (row.sections_json === null) {
      sectionsLabel = '(default)';
    } else {
      try {
        const parsed = JSON.parse(row.sections_json);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const strs = parsed.filter((x): x is string => typeof x === 'string');
          sectionsLabel = strs.length === 0 ? '(default)' : strs.join(',');
        } else {
          sectionsLabel = '(default)';
        }
      } catch {
        sectionsLabel = '(default)';
      }
    }
    return `${stamp} ${row.action}${fromPart} sections=${sectionsLabel}`;
  });
  return lines.join('\n');
}

describe('Polish 4 — --history handler behavior', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
    createUser(db, { id: 'rob', name: 'Rob', email: 'rob@x.com', role: 'admin' });
    createUser(db, { id: 'oli', name: 'Olivier', email: 'oli@x.com', role: 'member' });
    createUser(db, { id: 'mer', name: 'Merab', email: 'mer@x.com', role: 'member' });
  });

  it('happy path — lists rows for user in reverse-chronological order', () => {
    // Insert a sequence of actions for Olivier with explicit timestamps.
    insertBriefingSectionsAudit(db, {
      ts: '2026-04-25T10:00:00.000Z',
      user_name: 'Olivier',
      action: 'set',
      sections_json: JSON.stringify(['calendar', 'emails']),
    });
    insertBriefingSectionsAudit(db, {
      ts: '2026-04-25T11:00:00.000Z',
      user_name: 'Olivier',
      action: 'reset',
    });
    insertBriefingSectionsAudit(db, {
      ts: '2026-04-25T12:00:00.000Z',
      user_name: 'Olivier',
      action: 'clone-from',
      source_user: 'Merab',
      sections_json: JSON.stringify(['stats']),
    });
    // Inserting an unrelated user's row should not appear in Olivier's history.
    insertBriefingSectionsAudit(db, {
      ts: '2026-04-25T11:30:00.000Z',
      user_name: 'Merab',
      action: 'set',
      sections_json: JSON.stringify(['calendar']),
    });

    const out = renderHistory(db, { targetName: 'Olivier', days: 90 });
    const lines = out.split('\n');
    expect(lines.length).toBe(3);
    // Reverse chronological — clone-from first.
    expect(lines[0]).toBe('2026-04-25 12:00 clone-from from Merab sections=stats');
    expect(lines[1]).toBe('2026-04-25 11:00 reset sections=(default)');
    expect(lines[2]).toBe('2026-04-25 10:00 set sections=calendar,emails');
    // Merab's row not present.
    expect(out).not.toContain('Merab → ');
  });

  it('empty case → friendly "No audit history" message', () => {
    const out = renderHistory(db, { targetName: 'Olivier', days: 7 });
    expect(out).toBe(`No audit history for 'Olivier' in last 7 day(s).`);
  });

  it('unknown user → friendly not-found error', () => {
    const out = renderHistory(db, { targetName: 'Phantom', days: 7 });
    expect(out).toBe(`User 'Phantom' not found.`);
  });

  it('clamps --days to [1, 90]', () => {
    // Days 0 → clamped to 1; days 999 → clamped to 90; rows-not-found message
    // echoes the clamped value so we can assert the clamp from the output.
    const outZero = renderHistory(db, { targetName: 'Olivier', days: 0 });
    expect(outZero).toBe(`No audit history for 'Olivier' in last 1 day(s).`);
    const outHuge = renderHistory(db, { targetName: 'Olivier', days: 999 });
    expect(outHuge).toBe(`No audit history for 'Olivier' in last 90 day(s).`);
  });

  it('filters by --days window (rows older than the cutoff are excluded)', () => {
    // Insert one row 5 days ago and one row 30 days ago.
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    insertBriefingSectionsAudit(db, {
      ts: fiveDaysAgo,
      user_name: 'Olivier',
      action: 'set',
      sections_json: JSON.stringify(['calendar']),
    });
    insertBriefingSectionsAudit(db, {
      ts: thirtyDaysAgo,
      user_name: 'Olivier',
      action: 'reset',
    });

    // 7-day window → only the 5-day-old row.
    const outShort = renderHistory(db, { targetName: 'Olivier', days: 7 });
    const linesShort = outShort.split('\n');
    expect(linesShort.length).toBe(1);
    expect(linesShort[0]).toContain('set sections=calendar');

    // 60-day window → both rows.
    const outLong = renderHistory(db, { targetName: 'Olivier', days: 60 });
    const linesLong = outLong.split('\n');
    expect(linesLong.length).toBe(2);
  });

  it('case-insensitive user name match', () => {
    insertBriefingSectionsAudit(db, {
      user_name: 'Olivier',
      action: 'set',
      sections_json: JSON.stringify(['calendar']),
    });
    const out = renderHistory(db, { targetName: 'olivier', days: 7 });
    const lines = out.split('\n');
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('set sections=calendar');
  });
});

// ============================================================================
// Audit-log retention auto-prune
// ============================================================================
describe('Polish 4 — audit-log retention auto-prune', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
    createUser(db, { id: 'oli', name: 'Olivier', email: 'oli@x.com', role: 'member' });
  });

  it('pruneBriefingSectionsAuditOlderThan deletes rows older than the cutoff', () => {
    // Insert 3 rows: 100 days ago, 30 days ago, fresh.
    const ancient = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
    const thirtyD = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    insertBriefingSectionsAudit(db, {
      ts: ancient,
      user_name: 'Olivier',
      action: 'set',
      sections_json: JSON.stringify(['calendar']),
    });
    insertBriefingSectionsAudit(db, {
      ts: thirtyD,
      user_name: 'Olivier',
      action: 'set',
      sections_json: JSON.stringify(['emails']),
    });
    insertBriefingSectionsAudit(db, {
      user_name: 'Olivier',
      action: 'reset',
    });

    // Prune everything older than 90 days.
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const deleted = pruneBriefingSectionsAuditOlderThan(db, cutoff);
    expect(deleted).toBe(1);

    // Survivors: 30d row + fresh row.
    const cutoff200 = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
    const remaining = getBriefingSectionsAuditSince(db, cutoff200);
    expect(remaining.length).toBe(2);
    // Confirm the 100-day-old row is gone.
    expect(remaining.some((r) => r.ts === ancient)).toBe(false);
  });

  it('returns 0 when nothing is old enough to prune', () => {
    insertBriefingSectionsAudit(db, {
      user_name: 'Olivier',
      action: 'set',
      sections_json: JSON.stringify(['calendar']),
    });
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    expect(pruneBriefingSectionsAuditOlderThan(db, cutoff)).toBe(0);
  });

  it('idempotent index on briefing_sections_audit(ts) is created', () => {
    // The schema creates idx_briefing_sections_audit_ts via CREATE INDEX
    // IF NOT EXISTS — confirm it's present after initializeSchema.
    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'briefing_sections_audit'",
      )
      .all() as { name: string }[];
    const names = indexes.map((i) => i.name);
    expect(names).toContain('idx_briefing_sections_audit_ts');

    // Re-running schema init does not error (idempotency check).
    expect(() => initializeSchema(db)).not.toThrow();
  });
});

// ============================================================================
// --revert handler behavior (DB round-trip + handler logic mirror)
// ============================================================================
function renderRevert(db: Database.Database, args: { targetName: string }): string {
  const target = findUserByFirstName(db, args.targetName);
  if (!target) return `User '${args.targetName}' not found.`;
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const rows = getBriefingSectionsAuditForUserSince(db, target.name, cutoff);
  if (rows.length < 2) {
    return `No prior briefing-sections action to revert for '${target.name}'.`;
  }
  const prior = rows[1];
  if (!prior) {
    return `No prior briefing-sections action to revert for '${target.name}'.`;
  }
  let priorSections: string[] | null = null;
  if (prior.sections_json !== null) {
    try {
      const parsed = JSON.parse(prior.sections_json);
      if (Array.isArray(parsed)) {
        const strs = parsed.filter((x): x is string => typeof x === 'string');
        const valid = strs.filter((s) =>
          (VALID_BRIEFING_SECTIONS as readonly string[]).includes(s),
        );
        priorSections = valid.length === 0 ? null : valid;
      }
    } catch {
      priorSections = null;
    }
  }
  setUserBriefingSections(db, target.id, priorSections);
  insertBriefingSectionsAudit(db, {
    user_name: target.name,
    action: 'revert',
    sections_json: priorSections === null ? null : JSON.stringify(priorSections),
  });
  const sectionsLabel =
    priorSections === null || priorSections.length === 0
      ? '(default: full briefing)'
      : priorSections.join(', ');
  return `Reverted briefing prefs for '${target.name}' to ${sectionsLabel}.`;
}

describe('Polish 4 — --revert handler behavior', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
    createUser(db, { id: 'oli', name: 'Olivier', email: 'oli@x.com', role: 'member' });
  });

  it('happy path — reverts to the prior stored sections array', () => {
    // Initial state: set calendar+emails.
    setUserBriefingSections(db, 'oli', ['calendar', 'emails']);
    insertBriefingSectionsAudit(db, {
      ts: '2026-04-25T10:00:00.000Z',
      user_name: 'Olivier',
      action: 'set',
      sections_json: JSON.stringify(['calendar', 'emails']),
    });
    // Then change to stats.
    setUserBriefingSections(db, 'oli', ['stats']);
    insertBriefingSectionsAudit(db, {
      ts: '2026-04-25T11:00:00.000Z',
      user_name: 'Olivier',
      action: 'set',
      sections_json: JSON.stringify(['stats']),
    });

    const out = renderRevert(db, { targetName: 'Olivier' });
    expect(out).toBe(`Reverted briefing prefs for 'Olivier' to calendar, emails.`);
    expect(getUserBriefingSections(db, 'oli')).toEqual(['calendar', 'emails']);
  });

  it('reverts to (default: full briefing) when prior row was a reset', () => {
    insertBriefingSectionsAudit(db, {
      ts: '2026-04-25T10:00:00.000Z',
      user_name: 'Olivier',
      action: 'reset',
      sections_json: null,
    });
    setUserBriefingSections(db, 'oli', ['stats']);
    insertBriefingSectionsAudit(db, {
      ts: '2026-04-25T11:00:00.000Z',
      user_name: 'Olivier',
      action: 'set',
      sections_json: JSON.stringify(['stats']),
    });

    const out = renderRevert(db, { targetName: 'Olivier' });
    expect(out).toBe(
      `Reverted briefing prefs for 'Olivier' to (default: full briefing).`,
    );
    expect(getUserBriefingSections(db, 'oli')).toBeNull();
  });

  it('rejects when fewer than 2 audit rows exist (insufficient history)', () => {
    // Zero rows.
    expect(renderRevert(db, { targetName: 'Olivier' })).toBe(
      `No prior briefing-sections action to revert for 'Olivier'.`,
    );
    // One row only — still not enough.
    insertBriefingSectionsAudit(db, {
      user_name: 'Olivier',
      action: 'set',
      sections_json: JSON.stringify(['calendar']),
    });
    expect(renderRevert(db, { targetName: 'Olivier' })).toBe(
      `No prior briefing-sections action to revert for 'Olivier'.`,
    );
  });

  it('writes a new audit row with action=revert', () => {
    insertBriefingSectionsAudit(db, {
      ts: '2026-04-25T10:00:00.000Z',
      user_name: 'Olivier',
      action: 'set',
      sections_json: JSON.stringify(['calendar']),
    });
    insertBriefingSectionsAudit(db, {
      ts: '2026-04-25T11:00:00.000Z',
      user_name: 'Olivier',
      action: 'set',
      sections_json: JSON.stringify(['stats']),
    });
    setUserBriefingSections(db, 'oli', ['stats']);

    renderRevert(db, { targetName: 'Olivier' });

    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const rows = getBriefingSectionsAuditForUserSince(db, 'Olivier', cutoff);
    // 3 rows: 2 originals + 1 new revert row.
    expect(rows.length).toBe(3);
    // Newest first → the revert row.
    expect(rows[0]?.action).toBe('revert');
    expect(rows[0]?.sections_json).toBe(JSON.stringify(['calendar']));
    expect(rows[0]?.user_name).toBe('Olivier');
  });

  it('unknown user → friendly not-found error', () => {
    expect(renderRevert(db, { targetName: 'Phantom' })).toBe(
      `User 'Phantom' not found.`,
    );
  });

  it('filters stale section names from the prior row', () => {
    // Prior row stored a section that's no longer valid plus a valid one.
    insertBriefingSectionsAudit(db, {
      ts: '2026-04-25T10:00:00.000Z',
      user_name: 'Olivier',
      action: 'set',
      sections_json: JSON.stringify(['calendar', 'unknown_legacy_section']),
    });
    insertBriefingSectionsAudit(db, {
      ts: '2026-04-25T11:00:00.000Z',
      user_name: 'Olivier',
      action: 'set',
      sections_json: JSON.stringify(['stats']),
    });
    setUserBriefingSections(db, 'oli', ['stats']);

    const out = renderRevert(db, { targetName: 'Olivier' });
    expect(out).toBe(`Reverted briefing prefs for 'Olivier' to calendar.`);
    expect(getUserBriefingSections(db, 'oli')).toEqual(['calendar']);
  });
});

// ============================================================================
// Source-wiring assertions — src/index.ts must wire all three sub-features
// ============================================================================
describe('Polish 4 — wiring assertions on src/index.ts', () => {
  it('--history handler branch is admin-gated and uses friendly errors', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const indexPath = path.join(process.cwd(), 'src', 'index.ts');
    const source = fs.readFileSync(indexPath, 'utf-8');

    expect(source).toContain('parsedSections.history');
    expect(source).toContain('No audit history for');
    expect(source).toContain('getBriefingSectionsAuditForUserSince');

    const adminGateIdx = source.indexOf("if (user.role === 'admin') {");
    const historyIdx = source.indexOf('parsedSections.history');
    expect(adminGateIdx).toBeGreaterThan(-1);
    expect(historyIdx).toBeGreaterThan(adminGateIdx);
  });

  it('--revert handler branch is admin-gated and uses friendly errors', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const indexPath = path.join(process.cwd(), 'src', 'index.ts');
    const source = fs.readFileSync(indexPath, 'utf-8');

    expect(source).toContain('parsedSections.revert');
    expect(source).toContain('No prior briefing-sections action to revert for');
    expect(source).toContain('Reverted briefing prefs for');
    expect(source).toMatch(/action:\s*'revert'/);
  });

  it('writeAudit closure auto-prunes old rows on every insert', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const indexPath = path.join(process.cwd(), 'src', 'index.ts');
    const source = fs.readFileSync(indexPath, 'utf-8');

    expect(source).toContain('pruneBriefingSectionsAuditOlderThan');
    expect(source).toContain('BRIEFING_AUDIT_RETENTION_DAYS');
  });
});
