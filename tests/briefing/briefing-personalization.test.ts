/**
 * Briefing personalization — Task 7 (2026-04-22).
 *
 * `/briefing-preview --sections=<csv>` + per-user `briefing_sections_json`
 * + `/briefing-sections --user=<name> (--set=<csv> | --reset)`.
 *
 * What these tests cover (all 6 from Task 7, plus a few wiring assertions):
 *   1. --sections happy path parses + renders subset (only listed sections
 *      appear in the prompt body).
 *   2. Unknown section errors cleanly, listing the valid options — asserted
 *      via both the shared `parseSectionList` helper and the source of
 *      `src/index.ts` which must reference that helper.
 *   3. User with saved preference gets filtered prompt — `buildBriefingPrompt`
 *      honors the section set.
 *   4. NULL preference (getUserBriefingSections returns null) → no filter
 *      applied; prompt renders every provided section (legacy behavior
 *      preserved for the 5 AM scheduler path).
 *   5. /briefing-sections --reset clears the column to NULL.
 *   6. /briefing-sections is admin-gated at the handler site (source-level
 *      assertion on src/index.ts).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import {
  createUser,
  getUserById,
  getUserBriefingSections,
  setUserBriefingSections,
} from '../../src/db/user-queries.js';
import {
  VALID_BRIEFING_SECTIONS,
  parseSectionList,
  formatValidSectionsList,
  isValidBriefingSection,
} from '../../src/briefing/sections.js';
import { parseBriefingPreviewCommand } from '../../src/briefing/preview-command.js';
import { parseBriefingSectionsCommand } from '../../src/briefing/sections-command.js';
import { buildBriefingPrompt } from '../../src/briefing/generator.js';

// --- Shared fixtures ---
function sampleCalendar() {
  return {
    events: [
      {
        id: 'evt-1',
        source: 'outlook' as const,
        calendarEmail: 'rob@dearborndenim.com',
        title: 'Team standup',
        startTime: '2026-04-22T14:30:00Z',
        endTime: '2026-04-22T15:00:00Z',
        location: 'Teams',
        isAllDay: false,
        status: 'confirmed' as const,
        attendees: [],
      },
    ],
    conflicts: [],
    freeSlots: [],
    pendingActions: [],
  };
}

// ============================================================================
// Test 1 — `--sections=<csv>` happy path: parses + renders ONLY the subset.
// ============================================================================
describe('Task 7.1 — /briefing-preview --sections happy path', () => {
  it('parses --sections=calendar,emails and passes the raw csv through', () => {
    const parsed = parseBriefingPreviewCommand('/briefing-preview --sections=calendar,emails');
    expect(parsed.matched).toBe(true);
    expect(parsed.sectionsRaw).toBe('calendar,emails');
    // Bare, no --user flag.
    expect(parsed.targetName).toBeUndefined();
  });

  it('combines --user and --sections in either order', () => {
    const a = parseBriefingPreviewCommand('/briefing-preview --user=Olivier --sections=calendar,emails');
    expect(a.matched).toBe(true);
    expect(a.targetName).toBe('Olivier');
    expect(a.sectionsRaw).toBe('calendar,emails');

    const b = parseBriefingPreviewCommand('/briefing-preview --sections=calendar --user=Merab');
    expect(b.matched).toBe(true);
    expect(b.targetName).toBe('Merab');
    expect(b.sectionsRaw).toBe('calendar');
  });

  it('buildBriefingPrompt renders ONLY the listed sections when a filter is passed', () => {
    const prompt = buildBriefingPrompt(
      [],
      { totalProcessed: 42, archived: 10, flaggedForReview: 2 },
      sampleCalendar(),
      'OVERNIGHT: Foreman shipped 194 tests tonight',
      'PRODUCTION: 1,200 pieces yesterday',
      { name: 'Rob', business_context: null },
      'REQUEST #5: Robert wants widget X',
      { inventory: 'INVENTORY: 5 low SKUs', uninvoiced: 'UNINVOICED: $25k', wip: 'WIP: 800 pcs' },
      new Set(['calendar', 'emails']),
    );

    // Only calendar + emails should appear; everything else must be filtered.
    expect(prompt).toContain('TODAY\'S SCHEDULE');
    expect(prompt).toContain('CRITICAL urgency');
    // Filtered out:
    expect(prompt).not.toContain('OVERNIGHT DEV REPORT');
    expect(prompt).not.toContain('PRODUCTION: 1,200');
    expect(prompt).not.toContain('INVENTORY: 5 low SKUs');
    expect(prompt).not.toContain('PENDING DEV REQUESTS');
    // Stats also filtered because 'stats' isn't in the set.
    expect(prompt).not.toContain('Stats:');
  });
});

// ============================================================================
// Test 2 — Unknown section errors cleanly.
// ============================================================================
describe('Task 7.2 — unknown sections error cleanly with valid list', () => {
  it('parseSectionList splits valid vs invalid and preserves order of each', () => {
    const { valid, invalid } = parseSectionList('calendar, bogus, emails, also_bad');
    expect(valid).toEqual(['calendar', 'emails']);
    expect(invalid).toEqual(['bogus', 'also_bad']);
  });

  it('empty and all-invalid inputs are both surfaced to the caller', () => {
    expect(parseSectionList('').valid).toEqual([]);
    expect(parseSectionList('').invalid).toEqual([]);

    const allBad = parseSectionList('nope,also_nope');
    expect(allBad.valid).toEqual([]);
    expect(allBad.invalid).toEqual(['nope', 'also_nope']);
  });

  it('formatValidSectionsList returns the canonical ordered set', () => {
    const formatted = formatValidSectionsList();
    for (const name of VALID_BRIEFING_SECTIONS) {
      expect(formatted).toContain(name);
    }
    // Stable separator so error messages are deterministic.
    expect(formatted).toContain(', ');
  });

  it('index.ts wires the --sections error path through parseSectionList + formatValidSectionsList', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const indexPath = path.join(process.cwd(), 'src', 'index.ts');
    const source = fs.readFileSync(indexPath, 'utf-8');
    expect(source).toContain('parseSectionList');
    expect(source).toContain('formatValidSectionsList');
    expect(source).toMatch(/Invalid section name/i);
  });
});

// ============================================================================
// Test 3 — User with saved preference gets the filtered morning briefing.
// ============================================================================
describe('Task 7.3 — saved preference drives the morning briefing filter', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
    createUser(db, {
      id: 'u-rob',
      name: 'Rob McMillan',
      email: 'rob@dearborndenim.com',
      role: 'admin',
    });
  });

  it('writes JSON to briefing_sections_json and round-trips on read', () => {
    setUserBriefingSections(db, 'u-rob', ['calendar', 'emails']);
    const raw = getUserById(db, 'u-rob')?.briefing_sections_json;
    expect(raw).toBe(JSON.stringify(['calendar', 'emails']));
    expect(getUserBriefingSections(db, 'u-rob')).toEqual(['calendar', 'emails']);
  });

  it('buildBriefingPrompt honors exactly the stored subset and drops the rest', () => {
    setUserBriefingSections(db, 'u-rob', ['calendar']);
    const stored = getUserBriefingSections(db, 'u-rob');
    expect(stored).toEqual(['calendar']);

    const prompt = buildBriefingPrompt(
      [],
      { totalProcessed: 5, archived: 3, flaggedForReview: 2 },
      sampleCalendar(),
      'OVERNIGHT',
      'PRODUCTION DATA BLOCK',
      undefined,
      'DEV REQUESTS',
      undefined,
      new Set(stored!),
    );

    expect(prompt).toContain('TODAY\'S SCHEDULE');
    // Email urgency blocks and stats are both suppressed — user only wants calendar.
    expect(prompt).not.toContain('CRITICAL urgency');
    expect(prompt).not.toContain('PRODUCTION DATA BLOCK');
    expect(prompt).not.toContain('PENDING DEV REQUESTS');
    expect(prompt).not.toContain('Stats:');
  });
});

// ============================================================================
// Test 4 — NULL preference → user gets the full (legacy) briefing.
// ============================================================================
describe('Task 7.4 — NULL preference preserves legacy full-briefing behavior', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
    createUser(db, {
      id: 'u-new',
      name: 'New User',
      email: 'new@dd.com',
      role: 'member',
    });
  });

  it('newly-created users have NULL briefing_sections_json and the helper returns null', () => {
    const u = getUserById(db, 'u-new');
    expect(u?.briefing_sections_json).toBeNull();
    expect(getUserBriefingSections(db, 'u-new')).toBeNull();
  });

  it('buildBriefingPrompt with sections=undefined renders every provided section (no regression)', () => {
    const prompt = buildBriefingPrompt(
      [],
      { totalProcessed: 7, archived: 4, flaggedForReview: 3 },
      sampleCalendar(),
      'OVERNIGHT DEV REPORT body',
      'PRODUCTION block present',
      undefined,
      'DEV REQUEST body',
      { inventory: 'INV', uninvoiced: 'UNI', wip: 'WIP block' },
      // IMPORTANT: undefined here, not an empty Set — this is the 5 AM path
      // for every user without a stored preference.
      undefined,
    );

    expect(prompt).toContain('TODAY\'S SCHEDULE');
    expect(prompt).toContain('OVERNIGHT DEV REPORT');
    expect(prompt).toContain('PRODUCTION block present');
    expect(prompt).toContain('PENDING DEV REQUESTS');
    expect(prompt).toContain('Stats:');
    expect(prompt).toContain('CRITICAL urgency');
    // admin ops combined block (adminOpsSection concatenates whichever parts are present)
    expect(prompt).toContain('INV');
    expect(prompt).toContain('WIP block');
  });

  it('malformed JSON in briefing_sections_json degrades to NULL (never breaks 5 AM)', () => {
    // Write a bogus blob directly — simulates partial DB corruption.
    db.prepare('UPDATE users SET briefing_sections_json = ? WHERE id = ?').run('not-json', 'u-new');
    const stored = getUserBriefingSections(db, 'u-new');
    expect(stored).toBeNull();
  });

  it('every valid section name is recognized (no schema drift between helper and renderer)', () => {
    for (const name of VALID_BRIEFING_SECTIONS) {
      expect(isValidBriefingSection(name)).toBe(true);
    }
    expect(isValidBriefingSection('totally_fake_section')).toBe(false);
  });
});

// ============================================================================
// Test 5 — /briefing-sections --reset clears the column.
// ============================================================================
describe('Task 7.5 — /briefing-sections --reset clears preference', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
    createUser(db, {
      id: 'u-ol',
      name: 'Olivier Martin',
      email: 'olivier@dd.com',
      role: 'member',
    });
  });

  it('parses /briefing-sections --user=<name> --reset', () => {
    const parsed = parseBriefingSectionsCommand('/briefing-sections --user=Olivier --reset');
    expect(parsed.matched).toBe(true);
    expect(parsed.targetName).toBe('Olivier');
    expect(parsed.reset).toBe(true);
    expect(parsed.setRaw).toBeUndefined();
  });

  it('parses /briefing-sections --user=<name> --set=<csv>', () => {
    const parsed = parseBriefingSectionsCommand('/briefing-sections --user=Olivier --set=calendar,emails');
    expect(parsed.matched).toBe(true);
    expect(parsed.targetName).toBe('Olivier');
    expect(parsed.setRaw).toBe('calendar,emails');
    expect(parsed.reset).toBeUndefined();
  });

  it('rejects mixed --set + --reset and bare forms', () => {
    expect(parseBriefingSectionsCommand('/briefing-sections --user=Olivier --set=calendar --reset').matched).toBe(false);
    // Missing --user
    expect(parseBriefingSectionsCommand('/briefing-sections --reset').matched).toBe(false);
    // Missing either --set or --reset
    expect(parseBriefingSectionsCommand('/briefing-sections --user=Olivier').matched).toBe(false);
    // Bare
    expect(parseBriefingSectionsCommand('/briefing-sections').matched).toBe(false);
  });

  it('setUserBriefingSections(db, id, null) clears the column', () => {
    // Start with a value set.
    setUserBriefingSections(db, 'u-ol', ['calendar']);
    expect(getUserBriefingSections(db, 'u-ol')).toEqual(['calendar']);

    // Reset.
    setUserBriefingSections(db, 'u-ol', null);
    expect(getUserBriefingSections(db, 'u-ol')).toBeNull();
    expect(getUserById(db, 'u-ol')?.briefing_sections_json).toBeNull();
  });
});

// ============================================================================
// Test 6 — /briefing-sections handler is admin-gated (source-level).
// ============================================================================
describe('Task 7.6 — /briefing-sections is admin-gated', () => {
  it('index.ts guards /briefing-sections with user.role === admin', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const indexPath = path.join(process.cwd(), 'src', 'index.ts');
    const source = fs.readFileSync(indexPath, 'utf-8');

    // Find the /briefing-sections handler and assert an admin gate is wrapped
    // around it. We look up the parser import and scan backwards for the
    // role check, exactly like the existing /briefing-preview wiring tests do.
    const idx = source.indexOf('parseBriefingSectionsCommand');
    expect(idx).toBeGreaterThan(-1);
    const block = source.slice(Math.max(0, idx - 400), idx + 400);
    expect(block).toContain("user.role === 'admin'");
  });

  it('handleMorningBriefing uses getUserBriefingSections on the 5 AM path', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const indexPath = path.join(process.cwd(), 'src', 'index.ts');
    const source = fs.readFileSync(indexPath, 'utf-8');
    // The scheduler path must route stored preferences into runTriage so the
    // user actually receives a filtered briefing at 5 AM.
    const schedIdx = source.indexOf('async function handleMorningBriefing');
    expect(schedIdx).toBeGreaterThan(-1);
    const block = source.slice(schedIdx, schedIdx + 2000);
    expect(block).toContain('getUserBriefingSections');
    expect(block).toContain('runTriage');
  });
});
