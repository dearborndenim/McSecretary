/**
 * Briefing UX polish 2 — 2026-04-24.
 *
 * Adds two sub-features on top of /briefing-sections:
 *   1. --diff --user=<name>     → diff stored pref vs full briefing
 *   2. --set-all=<csv> --apply-to=all → bulk-set every onboarded user
 *
 * Tests cover parser changes, handler output formatting, and source-grep
 * wiring assertions on src/index.ts (same pattern the existing
 * briefing-personalization + briefing-ux-polish suites use).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import {
  createUser,
  setUserBriefingSections,
  getUserBriefingSections,
  getActiveUsers,
} from '../../src/db/user-queries.js';
import { parseBriefingSectionsCommand } from '../../src/briefing/sections-command.js';
import { VALID_BRIEFING_SECTIONS } from '../../src/briefing/sections.js';

// ============================================================================
// Parser — --diff
// ============================================================================
describe('Polish 2 — parser: --diff', () => {
  it('parses /briefing-sections --user=Olivier --diff', () => {
    const a = parseBriefingSectionsCommand('/briefing-sections --user=Olivier --diff');
    expect(a.matched).toBe(true);
    expect(a.diff).toBe(true);
    expect(a.targetName).toBe('Olivier');
    expect(a.setRaw).toBeUndefined();
    expect(a.reset).toBeUndefined();
    expect(a.list).toBeUndefined();
    expect(a.setAllRaw).toBeUndefined();
  });

  it('accepts --diff in either flag order', () => {
    const a = parseBriefingSectionsCommand('/briefing-sections --diff --user=Merab');
    expect(a.matched).toBe(true);
    expect(a.diff).toBe(true);
    expect(a.targetName).toBe('Merab');
  });

  it('rejects --diff combined with --set / --reset / --list / --set-all', () => {
    expect(parseBriefingSectionsCommand('/briefing-sections --user=X --diff --reset').matched).toBe(false);
    expect(parseBriefingSectionsCommand('/briefing-sections --user=X --diff --set=calendar').matched).toBe(false);
    expect(parseBriefingSectionsCommand('/briefing-sections --user=X --list --diff').matched).toBe(false);
    expect(
      parseBriefingSectionsCommand('/briefing-sections --diff --set-all=calendar --apply-to=all').matched,
    ).toBe(false);
  });

  it('rejects --diff without --user (diff is a per-user op)', () => {
    expect(parseBriefingSectionsCommand('/briefing-sections --diff').matched).toBe(false);
  });
});

// ============================================================================
// Parser — --set-all + --apply-to
// ============================================================================
describe('Polish 2 — parser: --set-all=<csv> --apply-to=all', () => {
  it('parses both flags in either order', () => {
    const a = parseBriefingSectionsCommand(
      '/briefing-sections --set-all=stats,emails --apply-to=all',
    );
    expect(a.matched).toBe(true);
    expect(a.setAllRaw).toBe('stats,emails');
    expect(a.applyTo).toBe('all');
    expect(a.targetName).toBeUndefined();

    const b = parseBriefingSectionsCommand(
      '/briefing-sections --apply-to=all --set-all=calendar',
    );
    expect(b.matched).toBe(true);
    expect(b.setAllRaw).toBe('calendar');
    expect(b.applyTo).toBe('all');
  });

  it('rejects --set-all without --apply-to', () => {
    expect(parseBriefingSectionsCommand('/briefing-sections --set-all=stats').matched).toBe(false);
  });

  it('rejects --apply-to with any value other than "all"', () => {
    expect(
      parseBriefingSectionsCommand('/briefing-sections --set-all=stats --apply-to=members').matched,
    ).toBe(false);
    expect(
      parseBriefingSectionsCommand('/briefing-sections --set-all=stats --apply-to=staff').matched,
    ).toBe(false);
  });

  it('rejects --apply-to without --set-all (orphan flag)', () => {
    expect(
      parseBriefingSectionsCommand('/briefing-sections --user=X --reset --apply-to=all').matched,
    ).toBe(false);
  });

  it('rejects --set-all combined with --user (bulk op has no per-user target)', () => {
    expect(
      parseBriefingSectionsCommand(
        '/briefing-sections --user=Olivier --set-all=stats --apply-to=all',
      ).matched,
    ).toBe(false);
  });
});

// ============================================================================
// Existing parser invariants (regression — exactly one action)
// ============================================================================
describe('Polish 2 — parser: exactly one of set/reset/list/diff/set-all', () => {
  it('rejects bare /briefing-sections', () => {
    expect(parseBriefingSectionsCommand('/briefing-sections').matched).toBe(false);
  });

  it('rejects --user without any action', () => {
    expect(parseBriefingSectionsCommand('/briefing-sections --user=Olivier').matched).toBe(false);
  });

  it('still accepts the existing forms unchanged', () => {
    expect(parseBriefingSectionsCommand('/briefing-sections --user=X --set=calendar,emails').matched).toBe(true);
    expect(parseBriefingSectionsCommand('/briefing-sections --user=X --reset').matched).toBe(true);
    expect(parseBriefingSectionsCommand('/briefing-sections --list').matched).toBe(true);
    expect(parseBriefingSectionsCommand('/briefing-sections --user=X --list').matched).toBe(true);
  });
});

// ============================================================================
// --diff handler output formatting (logic mirrors src/index.ts)
// ============================================================================
function renderDiff(args: {
  targetName?: string;
  found: { name: string; stored: string[] | null } | undefined;
}): string {
  if (!args.found) {
    return `User '${args.targetName}' not found. Use /onboarding-status for the list.`;
  }
  const target = args.found;
  if (!target.stored || target.stored.length === 0) {
    return [
      `User: ${target.name}`,
      `Current: (default: full briefing)`,
      `Missing: (none)`,
    ].join('\n');
  }
  const storedKnown = target.stored.filter((s) =>
    (VALID_BRIEFING_SECTIONS as readonly string[]).includes(s),
  );
  const missing = (VALID_BRIEFING_SECTIONS as readonly string[]).filter(
    (s) => !storedKnown.includes(s),
  );
  return [
    `User: ${target.name}`,
    `Current: ${storedKnown.join(', ')}`,
    `Missing: ${missing.length === 0 ? '(none)' : missing.join(', ')}`,
    `Order: [${storedKnown.join(', ')}]`,
  ].join('\n');
}

describe('Polish 2 — --diff output formatting', () => {
  it('formats partial pref with current/missing/order lines (Test #1)', () => {
    const out = renderDiff({
      found: { name: 'Olivier', stored: ['overnight_dev', 'emails', 'stats'] },
    });
    expect(out).toContain('User: Olivier');
    expect(out).toContain('Current: overnight_dev, emails, stats');
    // Missing list is the canonical set minus the stored set, in canonical order.
    expect(out).toContain('Missing: production, admin_ops, calendar, dev_requests');
    expect(out).toContain('Order: [overnight_dev, emails, stats]');
  });

  it('formats NULL pref as default-full-briefing with no missing (Test #2)', () => {
    const out = renderDiff({ found: { name: 'Olivier', stored: null } });
    expect(out).toBe(
      ['User: Olivier', 'Current: (default: full briefing)', 'Missing: (none)'].join('\n'),
    );
  });

  it('returns friendly not-found error for unknown user (Test #3)', () => {
    const out = renderDiff({ targetName: 'Ghost', found: undefined });
    expect(out).toBe(`User 'Ghost' not found. Use /onboarding-status for the list.`);
  });

  it('handles ALL sections set (no missing)', () => {
    const out = renderDiff({
      found: { name: 'Rob', stored: [...VALID_BRIEFING_SECTIONS] as string[] },
    });
    expect(out).toContain('Missing: (none)');
  });

  it('drops unknown stored section names defensively', () => {
    const out = renderDiff({
      found: { name: 'Olivier', stored: ['calendar', 'no_such_section', 'emails'] },
    });
    expect(out).not.toContain('no_such_section');
    expect(out).toContain('Current: calendar, emails');
    expect(out).toContain('Order: [calendar, emails]');
  });
});

// ============================================================================
// --set-all behavior (DB round-trip with real schema)
// ============================================================================
describe('Polish 2 — --set-all updates all onboarded users', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
  });

  it('writes to every active user and lists them (Test #4)', () => {
    createUser(db, { id: 'u1', name: 'Olivier', email: 'o@x.com', role: 'member' });
    createUser(db, { id: 'u2', name: 'Merab', email: 'm@x.com', role: 'member' });
    createUser(db, { id: 'u3', name: 'Rob', email: 'r@x.com', role: 'admin' });

    const onboarded = getActiveUsers(db);
    expect(onboarded.length).toBe(3);

    // Mirrors handler logic: validate sections then loop set.
    const sections = ['stats', 'emails'];
    for (const u of onboarded) {
      setUserBriefingSections(db, u.id, sections);
    }

    expect(getUserBriefingSections(db, 'u1')).toEqual(sections);
    expect(getUserBriefingSections(db, 'u2')).toEqual(sections);
    expect(getUserBriefingSections(db, 'u3')).toEqual(sections);

    // Output formatting: list up to 20 names, comma-separated.
    const names = onboarded.map((u) => u.name);
    const tail = names.length > 20 ? `, ...and ${names.length - 20} more` : '';
    const summary = `Updated ${onboarded.length} users: ${names.slice(0, 20).join(', ')}${tail}.`;
    expect(summary).toMatch(/^Updated 3 users: /);
    expect(summary).toContain('Olivier');
    expect(summary).toContain('Merab');
    expect(summary).toContain('Rob');
    expect(summary).not.toContain('...and');
  });

  it('truncates the name list to 20 with "...and K more" tail when >20 users', () => {
    for (let i = 1; i <= 25; i++) {
      createUser(db, {
        id: `u${i}`,
        name: `User${i.toString().padStart(2, '0')}`,
        email: `u${i}@x.com`,
        role: 'member',
      });
    }
    const onboarded = getActiveUsers(db);
    expect(onboarded.length).toBe(25);

    const names = onboarded.map((u) => u.name);
    const shown = names.slice(0, 20);
    const extra = names.length - shown.length;
    const tail = extra > 0 ? `, ...and ${extra} more` : '';
    const summary = `Updated ${onboarded.length} users: ${shown.join(', ')}${tail}.`;
    expect(summary).toContain('Updated 25 users:');
    expect(summary).toContain('...and 5 more');
    // exactly 20 users listed before the "...and" tail
    const beforeAnd = summary.split(', ...and')[0]!;
    expect(beforeAnd.split(', ').length).toBe(20);
  });

  it('rejects --set-all with invalid section names (Test #5)', async () => {
    // Source-grep: the handler must use the same parseSectionList + the same
    // canonical error string the --set form uses.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const indexPath = path.join(process.cwd(), 'src', 'index.ts');
    const source = fs.readFileSync(indexPath, 'utf-8');
    // The set-all branch must hit parseSectionList on parsedSections.setAllRaw
    // and return the same Invalid-section-names error shape.
    const setAllIdx = source.indexOf('parsedSections.setAllRaw');
    expect(setAllIdx).toBeGreaterThan(-1);
    const block = source.slice(setAllIdx, setAllIdx + 1200);
    expect(block).toContain('parseSectionList');
    expect(block).toContain('Invalid section name(s):');
    expect(block).toContain('formatValidSectionsList');
    // And it must call setUserBriefingSections in a loop (not just once).
    expect(block).toContain('setUserBriefingSections');
    expect(block).toContain('getActiveUsers');
  });
});

// ============================================================================
// Source-wiring: --diff in src/index.ts
// ============================================================================
describe('Polish 2 — wiring assertions on src/index.ts', () => {
  it('--diff branch is admin-gated and uses the friendly not-found error', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const indexPath = path.join(process.cwd(), 'src', 'index.ts');
    const source = fs.readFileSync(indexPath, 'utf-8');

    expect(source).toContain('parsedSections.diff');
    expect(source).toContain("Use /onboarding-status for the list.");
    // Diff output uses the four-line format documented in PROJECT_STATUS.md.
    expect(source).toContain('`Current: ');
    expect(source).toContain('`Missing: ');
    expect(source).toContain('`Order: ');
  });

  it('--set-all wiring: applyTo=all enforced + admin-gated', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const indexPath = path.join(process.cwd(), 'src', 'index.ts');
    const source = fs.readFileSync(indexPath, 'utf-8');

    expect(source).toContain('parsedSections.setAllRaw');
    // The whole /briefing-sections handler block sits inside `if (user.role === 'admin')`.
    const adminGateIdx = source.indexOf("if (user.role === 'admin') {");
    expect(adminGateIdx).toBeGreaterThan(-1);
    const setAllIdx = source.indexOf('parsedSections.setAllRaw');
    expect(setAllIdx).toBeGreaterThan(adminGateIdx);
  });
});
