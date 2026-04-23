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
