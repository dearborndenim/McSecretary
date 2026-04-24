/**
 * Briefing UX polish — Task 7 (2026-04-23).
 *
 * Polishes the briefing personalization shipped 2026-04-22:
 *   1. /briefing-sections --list — both bare (catalog) and --user (stored pref).
 *   2. /briefing-preview --sections + --user — override stored pref for preview only.
 *   3. Per-section ordering preference — render order matches the stored array.
 *
 * Mirrors the test pattern from briefing-personalization.test.ts so the two
 * suites compose cleanly — every parser/renderer change is covered both at
 * the unit level and via wiring assertions on src/index.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import {
  createUser,
  setUserBriefingSections,
} from '../../src/db/user-queries.js';
import {
  VALID_BRIEFING_SECTIONS,
  BRIEFING_SECTION_DESCRIPTIONS,
  formatSectionListWithDescriptions,
  type BriefingSectionName,
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
        startTime: '2026-04-23T14:30:00Z',
        endTime: '2026-04-23T15:00:00Z',
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
// Sub-task 1 — /briefing-sections --list
// ============================================================================
describe('Task 7 polish — /briefing-sections --list', () => {
  it('parser accepts bare /briefing-sections --list (no --user)', () => {
    const parsed = parseBriefingSectionsCommand('/briefing-sections --list');
    expect(parsed.matched).toBe(true);
    expect(parsed.list).toBe(true);
    expect(parsed.targetName).toBeUndefined();
    expect(parsed.setRaw).toBeUndefined();
    expect(parsed.reset).toBeUndefined();
  });

  it('parser accepts /briefing-sections --user=<name> --list in either flag order', () => {
    const a = parseBriefingSectionsCommand('/briefing-sections --user=Olivier --list');
    expect(a.matched).toBe(true);
    expect(a.list).toBe(true);
    expect(a.targetName).toBe('Olivier');

    const b = parseBriefingSectionsCommand('/briefing-sections --list --user=Merab');
    expect(b.matched).toBe(true);
    expect(b.list).toBe(true);
    expect(b.targetName).toBe('Merab');
  });

  it('parser rejects --list combined with --set or --reset (mutually exclusive actions)', () => {
    expect(parseBriefingSectionsCommand('/briefing-sections --user=X --list --reset').matched).toBe(false);
    expect(parseBriefingSectionsCommand('/briefing-sections --user=X --list --set=calendar').matched).toBe(false);
    expect(parseBriefingSectionsCommand('/briefing-sections --user=X --set=calendar --list').matched).toBe(false);
  });

  it('formatSectionListWithDescriptions emits every valid section with a description', () => {
    const out = formatSectionListWithDescriptions();
    for (const name of VALID_BRIEFING_SECTIONS) {
      expect(out).toContain(`- ${name}: `);
      expect(out).toContain(BRIEFING_SECTION_DESCRIPTIONS[name]);
    }
    // Should be a multi-line list — one bullet per section.
    expect(out.split('\n').length).toBe(VALID_BRIEFING_SECTIONS.length);
  });

  it('BRIEFING_SECTION_DESCRIPTIONS has no schema drift vs VALID_BRIEFING_SECTIONS', () => {
    const descKeys = Object.keys(BRIEFING_SECTION_DESCRIPTIONS).sort();
    const valid = [...VALID_BRIEFING_SECTIONS].sort();
    expect(descKeys).toEqual(valid);
    for (const name of VALID_BRIEFING_SECTIONS) {
      expect(BRIEFING_SECTION_DESCRIPTIONS[name as BriefingSectionName].length).toBeGreaterThan(0);
    }
  });

  it('index.ts wires /briefing-sections --list through formatSectionListWithDescriptions and getUserBriefingSections', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const indexPath = path.join(process.cwd(), 'src', 'index.ts');
    const source = fs.readFileSync(indexPath, 'utf-8');
    expect(source).toContain('formatSectionListWithDescriptions');
    expect(source).toContain('parsedSections.list');
    expect(source).toContain('getUserBriefingSections');
    // The "(default: full briefing)" fallback line must be present so users
    // with NULL prefs see explicit feedback, not an empty "preference: " line.
    expect(source).toContain('(default: full briefing)');
  });
});

// ============================================================================
// Sub-task 2 — /briefing-preview --sections + --user combined override
// ============================================================================
describe('Task 7 polish — /briefing-preview --sections overrides saved pref for preview only', () => {
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

  it('parser accepts both flags together regardless of order', () => {
    const a = parseBriefingPreviewCommand('/briefing-preview --user=Olivier --sections=stats,emails');
    expect(a.matched).toBe(true);
    expect(a.targetName).toBe('Olivier');
    expect(a.sectionsRaw).toBe('stats,emails');

    const b = parseBriefingPreviewCommand('/briefing-preview --sections=calendar,stats --user=Olivier');
    expect(b.matched).toBe(true);
    expect(b.targetName).toBe('Olivier');
    expect(b.sectionsRaw).toBe('calendar,stats');
  });

  it('preview --sections override does NOT persist to briefing_sections_json', async () => {
    // User has a stored pref of calendar + emails.
    setUserBriefingSections(db, 'u-ol', ['calendar', 'emails']);

    // Simulate the preview path by reading back BEFORE and AFTER a hypothetical
    // override invocation. The handler in src/index.ts hands `sectionsFilter`
    // straight to runTriage and never writes back; the test verifies that
    // contract by source-grepping for the absence of any setUserBriefingSections
    // call inside the /briefing-preview handler block.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const indexPath = path.join(process.cwd(), 'src', 'index.ts');
    const source = fs.readFileSync(indexPath, 'utf-8');
    const previewIdx = source.indexOf('parseBriefingPreviewCommand');
    expect(previewIdx).toBeGreaterThan(-1);
    // Slice out the entire /briefing-preview handler (from its parser import
    // to the start of /briefing-sections handler).
    const sectionsIdx = source.indexOf('parseBriefingSectionsCommand');
    expect(sectionsIdx).toBeGreaterThan(previewIdx);
    const previewBlock = source.slice(previewIdx, sectionsIdx);
    expect(previewBlock).not.toContain('setUserBriefingSections');
    // But it MUST hand sections through to runTriage so the override works.
    expect(previewBlock).toContain('runTriage');
    expect(previewBlock).toContain('sections');

    // And the stored pref is still intact after we would have run the preview.
    const { getUserBriefingSections } = await import('../../src/db/user-queries.js');
    expect(getUserBriefingSections(db, 'u-ol')).toEqual(['calendar', 'emails']);
  });

  it('user without a stored pref + --sections override produces a filtered prompt', () => {
    // Reproduces the render side: when --sections is supplied, the prompt
    // contains ONLY the override sections regardless of any stored pref.
    const prompt = buildBriefingPrompt(
      [],
      { totalProcessed: 9, archived: 4, flaggedForReview: 1 },
      sampleCalendar(),
      'OVERNIGHT body',
      'PRODUCTION body',
      { name: 'Olivier', business_context: null },
      'DEV REQUESTS body',
      undefined,
      ['stats', 'calendar'], // override
    );
    expect(prompt).toContain('Stats:');
    expect(prompt).toContain('TODAY\'S SCHEDULE');
    expect(prompt).not.toContain('OVERNIGHT body');
    expect(prompt).not.toContain('PRODUCTION body');
    expect(prompt).not.toContain('CRITICAL urgency');
    expect(prompt).not.toContain('PENDING DEV REQUESTS');
  });

  it('invalid section in csv produces same error shape as today (handler-level wiring assertion)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const indexPath = path.join(process.cwd(), 'src', 'index.ts');
    const source = fs.readFileSync(indexPath, 'utf-8');
    // Same canonical error string is used by the preview handler today.
    expect(source).toMatch(/Invalid section name\(s\): \$\{invalid\.join/);
    // And it's reachable from the parsed sectionsRaw branch.
    const previewIdx = source.indexOf('parsedPreview.sectionsRaw');
    expect(previewIdx).toBeGreaterThan(-1);
    const tail = source.slice(previewIdx, previewIdx + 800);
    expect(tail).toContain('parseSectionList');
    expect(tail).toContain('formatValidSectionsList');
  });
});

// ============================================================================
// Sub-task 3 — Per-section ordering preference
// ============================================================================
describe('Task 7 polish — array order from briefing_sections_json drives prompt order', () => {
  // Helper: locate each section's start index in the prompt and assert the
  // order matches the input array. We use distinctive header substrings that
  // cannot appear inside other sections' bodies.
  const HEADERS: Record<string, string> = {
    stats: 'Stats:',
    overnight_dev: 'OVERNIGHT DEV REPORT',
    production: 'PRODUCTION_HEADER_MARKER',
    admin_ops: 'ADMIN_OPS_INVENTORY_MARKER',
    calendar: "TODAY'S SCHEDULE",
    dev_requests: 'PENDING DEV REQUESTS',
    emails: 'CRITICAL urgency',
  };

  function indexFor(prompt: string, name: string): number {
    return prompt.indexOf(HEADERS[name]!);
  }

  function buildFullPrompt(sections?: readonly string[] | Set<string>) {
    return buildBriefingPrompt(
      [],
      { totalProcessed: 11, archived: 6, flaggedForReview: 2 },
      sampleCalendar(),
      'OVERNIGHT DEV REPORT body',
      'PRODUCTION_HEADER_MARKER body',
      { name: 'Rob', business_context: null },
      'DEV REQUEST body',
      { inventory: 'ADMIN_OPS_INVENTORY_MARKER body', uninvoiced: 'UNINVOICED body', wip: 'WIP body' },
      sections,
    );
  }

  it('renders sections in the EXACT order given by the array', () => {
    const order = ['calendar', 'stats', 'emails'];
    const prompt = buildFullPrompt(order);

    const positions = order.map((name) => indexFor(prompt, name));
    // Every section must be present AND each subsequent index must be greater.
    for (const pos of positions) expect(pos).toBeGreaterThan(-1);
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1]!);
    }

    // Sections NOT in the array must be absent (filter still applies).
    expect(prompt).not.toContain(HEADERS.overnight_dev);
    expect(prompt).not.toContain(HEADERS.production);
    expect(prompt).not.toContain(HEADERS.admin_ops);
    expect(prompt).not.toContain(HEADERS.dev_requests);
  });

  it('reverses the default order when the array is reversed', () => {
    const reversed = ['emails', 'dev_requests', 'calendar', 'admin_ops', 'production', 'overnight_dev', 'stats'];
    const prompt = buildFullPrompt(reversed);

    // Every section is rendered (filter is identity); order matches reversed.
    const positions = reversed.map((name) => indexFor(prompt, name));
    for (const pos of positions) expect(pos).toBeGreaterThan(-1);
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1]!);
    }
  });

  it('NULL preference (sections=undefined) preserves the legacy default order', () => {
    // Default order: stats, overnight_dev, production, admin_ops, calendar, dev_requests, emails.
    const prompt = buildFullPrompt(undefined);
    const expectedOrder = ['stats', 'overnight_dev', 'production', 'admin_ops', 'calendar', 'dev_requests', 'emails'];
    const positions = expectedOrder.map((name) => indexFor(prompt, name));
    for (const pos of positions) expect(pos).toBeGreaterThan(-1);
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1]!);
    }
  });

  it('Set<string> filter falls back to the default order (Sets are not ordered prefs)', () => {
    // Even when the Set's iteration order would suggest [calendar, stats],
    // the renderer must use the canonical default order: stats then calendar.
    const prompt = buildFullPrompt(new Set(['calendar', 'stats']));
    const calendarPos = indexFor(prompt, 'calendar');
    const statsPos = indexFor(prompt, 'stats');
    expect(calendarPos).toBeGreaterThan(-1);
    expect(statsPos).toBeGreaterThan(-1);
    expect(statsPos).toBeLessThan(calendarPos); // stats first per default order
  });

  it('triage.ts forwards the array (not a Set) so order survives end-to-end', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const triagePath = path.join(process.cwd(), 'src', 'triage.ts');
    const source = fs.readFileSync(triagePath, 'utf-8');
    // The variable name and the absence of a Set wrapper around options.sections
    // guarantee that the user's stored array order is forwarded to generateBriefing.
    expect(source).toContain('sectionsOrdered');
    // Specifically: must NOT wrap options.sections in `new Set(...)` anywhere
    // in the briefing-generation block.
    const genIdx = source.indexOf('generateBriefing(allClassified');
    expect(genIdx).toBeGreaterThan(-1);
    const block = source.slice(Math.max(0, genIdx - 400), genIdx + 400);
    expect(block).not.toMatch(/new Set\(options\.sections\)/);
  });

  it('unknown section names in the array are silently dropped (defense in depth)', () => {
    // The handler validates first, but the renderer must also be defensive so
    // a stale stored pref containing a removed section name cannot crash the
    // 5 AM scheduler. Filter just drops unknowns.
    const prompt = buildFullPrompt(['calendar', 'no_such_section', 'stats']);
    expect(prompt).toContain(HEADERS.calendar);
    expect(prompt).toContain(HEADERS.stats);
    // No literal "no_such_section" string leaks into the prompt body.
    expect(prompt).not.toContain('no_such_section');
  });

  it('CLAUDE.md documents that section order is honored from the stored array', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const claudePath = path.join(process.cwd(), 'CLAUDE.md');
    const source = fs.readFileSync(claudePath, 'utf-8');
    expect(source).toMatch(/order/i);
    expect(source).toContain('briefing-sections');
    expect(source).toContain('--list');
  });
});
