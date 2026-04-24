/**
 * Valid section names for briefing personalization (Task 7, 2026-04-22).
 *
 * Each name corresponds to a conditional block in `buildBriefingPrompt`
 * (src/briefing/generator.ts). When a user has `briefing_sections_json`
 * set, only sections listed there render in their 5 AM briefing. Admin
 * previews can request a subset via `/briefing-preview --sections=...`.
 *
 * Keeping this list in one place so the parser, renderer, and admin writer
 * all validate against the same canonical set.
 */

export const VALID_BRIEFING_SECTIONS = [
  'overnight_dev',   // NIGHTLY_PLAN.md summary from GitHub
  'production',      // Factory production from piece-work-scanner
  'admin_ops',       // Inventory + uninvoiced + WIP (admin-only source)
  'calendar',        // Today's schedule + conflicts + free time
  'dev_requests',    // Pending dev requests awaiting admin approval
  'emails',          // Critical/high/medium/low urgency emails
  'stats',           // Emails processed / archived / flagged counts
] as const;

export type BriefingSectionName = (typeof VALID_BRIEFING_SECTIONS)[number];

/**
 * One-line human-friendly descriptions used by `/briefing-sections --list`
 * (Task 7 polish, 2026-04-23). Keys MUST stay in lockstep with
 * VALID_BRIEFING_SECTIONS — schema-drift protection is exercised by the
 * test suite.
 */
export const BRIEFING_SECTION_DESCRIPTIONS: Record<BriefingSectionName, string> = {
  overnight_dev: 'Overnight AI agent empire build report from NIGHTLY_PLAN.md.',
  production:    'Factory production numbers and trends from piece-work-scanner.',
  admin_ops:     'Inventory on hand, uninvoiced PO totals, and WIP (admin only).',
  calendar:      "Today's schedule, conflicts, and free time blocks.",
  dev_requests:  'Pending team dev requests awaiting admin review.',
  emails:        'Critical / high / medium / low urgency email triage list.',
  stats:         'Counts: emails processed, auto-archived, flagged for review.',
};

/**
 * Render the canonical section list with one-line descriptions, one per line.
 * Used by `/briefing-sections --list` (no --user) so the admin can see every
 * supported section name without crawling source.
 */
export function formatSectionListWithDescriptions(): string {
  return VALID_BRIEFING_SECTIONS
    .map((name) => `- ${name}: ${BRIEFING_SECTION_DESCRIPTIONS[name]}`)
    .join('\n');
}

/** Case-sensitive membership check — section names are lower_snake_case. */
export function isValidBriefingSection(name: string): name is BriefingSectionName {
  return (VALID_BRIEFING_SECTIONS as readonly string[]).includes(name);
}

/**
 * Parse a comma-separated section list. Returns `{ valid, invalid }` so the
 * caller can error on any unknown name while still seeing the full valid
 * subset. Whitespace around each entry is tolerated. Empty input returns
 * empty arrays.
 */
export function parseSectionList(raw: string): { valid: BriefingSectionName[]; invalid: string[] } {
  const valid: BriefingSectionName[] = [];
  const invalid: string[] = [];
  if (!raw) return { valid, invalid };
  const parts = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  for (const part of parts) {
    if (isValidBriefingSection(part)) valid.push(part);
    else invalid.push(part);
  }
  return { valid, invalid };
}

/**
 * Render a human-friendly list of valid sections for error messages. Stable
 * ordering so Telegram output is deterministic for tests.
 */
export function formatValidSectionsList(): string {
  return VALID_BRIEFING_SECTIONS.join(', ');
}
