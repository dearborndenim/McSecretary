import Anthropic from '@anthropic-ai/sdk';
import type { ClassifiedEmail } from '../email/types.js';
import type { CalendarBriefingData } from '../calendar/types.js';

export interface UserBriefingContext {
  name: string;
  business_context: string | null;
}

function getBriefingSystemPrompt(userContext?: UserBriefingContext): string {
  const userName = userContext?.name ?? 'Rob McMillan';
  const businessCtx = userContext?.business_context
    ?? "Rob owns Dearborn Denim (rob@dearborndenim.com) and McMillan Manufacturing (robert@mcmillan-manufacturing.com). Email is Outlook-only (2 accounts).";

  return `You are McSecretary, an AI secretary generating ${userName}'s morning briefing.

${businessCtx}

Generate a concise, actionable morning briefing in markdown format. Structure:

1. **Overnight Dev** — Summary of what the AI agent empire built overnight. Only include if overnight build data is provided.
2. **Factory Production** — Yesterday's production numbers, trends vs last week, and any notable streaks. Only include if production data is provided.
3. **Operations Snapshot** — Inventory on hand, uninvoiced PO totals by brand, and work-in-progress summary. Only include if ops data is provided (admin only).
4. **Today's Schedule** — Calendar events for today with times (Chicago time), conflicts flagged with suggestions, and free time blocks. Only include if calendar data is provided.
5. **Needs Your Attention** — Critical/high urgency email items requiring a response. Include sender, one-line summary, and suggested action.
6. **For Your Review** — Medium priority items to look at when time allows.
7. **FYI / Handled** — What was auto-archived or marked as informational.
8. **Stats** — How many emails processed, archived, flagged.
9. **Dev Requests** — Pending feature requests from team members awaiting your review. Only include if dev request data is provided. Show request ID, who submitted it, and the description.

Keep it conversational but direct. ${userName} is busy — lead with what matters.
Don't use emoji. Use Central Time (Chicago) for all times.`;
}

export interface BriefingStats {
  totalProcessed: number;
  archived: number;
  flaggedForReview: number;
}

export interface AdminOpsSections {
  inventory?: string;
  uninvoiced?: string;
  wip?: string;
}

/**
 * Default render order — used when no explicit per-user section preference
 * is supplied (Task 7 polish, 2026-04-23). Pre-2026-04-23 behavior was to
 * concatenate sections in this exact sequence; preserving the legacy default
 * means every user without `briefing_sections_json` sees their briefing in
 * the historical order.
 */
const DEFAULT_BRIEFING_SECTION_ORDER: readonly string[] = [
  'stats',
  'overnight_dev',
  'production',
  'admin_ops',
  'calendar',
  'dev_requests',
  'emails',
];

export type BriefingSectionFilter = readonly string[] | Set<string>;

/**
 * Section-filter helper for Task 7 (2026-04-22).
 *
 * - `undefined` (default) → render every section whose data is provided.
 *   This is the legacy behavior and must be preserved for every user who
 *   has not set `briefing_sections_json`.
 * - `Set<string>` of section names → render ONLY those sections. Order is
 *   the canonical default order (Set has no meaningful order).
 * - `readonly string[]` of section names (Task 7 polish, 2026-04-23) →
 *   render ONLY those sections AND honor the array's order. Unknown names
 *   are silently dropped (defense in depth — handler validates first).
 *
 * Stats is always included in the prompt body even when filtered out because
 * the emails block reads from `stats` in its header line; filtering `stats`
 * only suppresses the "Stats:" preamble block.
 */
function sectionEnabled(sections: BriefingSectionFilter | undefined, name: string): boolean {
  if (sections === undefined) return true;
  if (sections instanceof Set) return sections.has(name);
  return sections.includes(name);
}

/**
 * Resolve the order in which section blocks should be concatenated.
 *
 * - `undefined` → canonical default order.
 * - `Set<string>` → canonical default order intersected with the set
 *   (Sets are not user-ordered preferences).
 * - `readonly string[]` → honor the array order. Unknown names are dropped
 *   so a stale stored pref can't surface a section that no longer exists.
 */
function resolveSectionOrder(sections: BriefingSectionFilter | undefined): readonly string[] {
  if (sections === undefined) return DEFAULT_BRIEFING_SECTION_ORDER;
  if (sections instanceof Set) {
    return DEFAULT_BRIEFING_SECTION_ORDER.filter((name) => sections.has(name));
  }
  return sections.filter((name) => DEFAULT_BRIEFING_SECTION_ORDER.includes(name));
}

export function buildBriefingPrompt(
  emails: ClassifiedEmail[],
  stats: BriefingStats,
  calendar?: CalendarBriefingData,
  overnightDevSummary?: string,
  productionSummary?: string,
  userContext?: UserBriefingContext,
  pendingDevRequests?: string,
  adminOps?: AdminOpsSections,
  sections?: BriefingSectionFilter,
): string {
  const critical = emails.filter((e) => e.urgency === 'critical');
  const high = emails.filter((e) => e.urgency === 'high');
  const medium = emails.filter((e) => e.urgency === 'medium');
  const low = emails.filter((e) => e.urgency === 'low');

  const formatEmails = (list: ClassifiedEmail[]): string =>
    list.length === 0
      ? 'None'
      : list
          .map(
            (e) =>
              `- From: ${e.senderName} <${e.sender}> (${e.account})\n  Subject: ${e.subject}\n  Summary: ${e.summary}\n  Suggested action: ${e.suggestedAction}`,
          )
          .join('\n');

  let calendarSection = '';
  if (calendar && sectionEnabled(sections, 'calendar')) {
    const eventList = calendar.events.length === 0
      ? 'No events scheduled.'
      : calendar.events
          .map((e) => `- [ID:${e.id}] ${e.startTime} to ${e.endTime}: ${e.title} (${e.calendarEmail})${e.location ? ` — ${e.location}` : ''}`)
          .join('\n');

    const conflictList = calendar.conflicts.length === 0
      ? 'None'
      : calendar.conflicts
          .map((c) => `- CONFLICT: "${c.eventA.title}" overlaps with "${c.eventB.title}" by ${c.overlapMinutes} minutes.\n  Suggestion: ${c.suggestion ?? 'Manual resolution needed'}`)
          .join('\n');

    const freeList = calendar.freeSlots.length === 0
      ? 'No free blocks today.'
      : calendar.freeSlots
          .map((s) => `- ${s.start} to ${s.end} (${s.durationMinutes} min)`)
          .join('\n');

    const pendingList = calendar.pendingActions.length === 0
      ? ''
      : '\nPending actions awaiting approval:\n' +
        calendar.pendingActions.map((a) => `- ${a.description}`).join('\n');

    calendarSection = `
TODAY'S SCHEDULE:
${eventList}

CONFLICTS:
${conflictList}

FREE TIME BLOCKS:
${freeList}
${pendingList}
`;
  }

  let overnightSection = '';
  if (overnightDevSummary && sectionEnabled(sections, 'overnight_dev')) {
    overnightSection = `
OVERNIGHT DEV REPORT:
${overnightDevSummary}
`;
  }

  let productionSection = '';
  if (productionSummary && sectionEnabled(sections, 'production')) {
    productionSection = `
${productionSummary}
`;
  }

  let devRequestsSection = '';
  if (pendingDevRequests && sectionEnabled(sections, 'dev_requests')) {
    devRequestsSection = `
PENDING DEV REQUESTS (awaiting your review):
${pendingDevRequests}
`;
  }

  let adminOpsSection = '';
  if (adminOps && (adminOps.inventory || adminOps.uninvoiced || adminOps.wip) && sectionEnabled(sections, 'admin_ops')) {
    const parts: string[] = [];
    if (adminOps.inventory) parts.push(adminOps.inventory);
    if (adminOps.uninvoiced) parts.push(adminOps.uninvoiced);
    if (adminOps.wip) parts.push(adminOps.wip);
    adminOpsSection = `
${parts.join('\n\n')}
`;
  }

  const statsBlock = sectionEnabled(sections, 'stats')
    ? `Stats:
- Total emails processed: ${stats.totalProcessed}
- Auto-archived: ${stats.archived}
- Flagged for review: ${stats.flaggedForReview}
`
    : '';

  const emailsBlock = sectionEnabled(sections, 'emails')
    ? `
CRITICAL urgency:
${formatEmails(critical)}

HIGH urgency:
${formatEmails(high)}

MEDIUM urgency:
${formatEmails(medium)}

LOW urgency:
${formatEmails(low)}`
    : '';

  // Section name → rendered block. Empty strings are dropped during assembly
  // (a section with no data — e.g., no calendar fixture — should not produce
  // an empty header). This map is the single source of truth for the link
  // between a section name and its rendered prompt fragment.
  const blocksByName: Record<string, string> = {
    stats: statsBlock,
    overnight_dev: overnightSection,
    production: productionSection,
    admin_ops: adminOpsSection,
    calendar: calendarSection,
    dev_requests: devRequestsSection,
    emails: emailsBlock,
  };

  // Honor the user's stored array order when supplied; otherwise fall back
  // to the canonical default order so legacy behavior is byte-identical.
  const order = resolveSectionOrder(sections);
  const body = order
    .map((name) => blocksByName[name])
    .filter((block): block is string => typeof block === 'string' && block.length > 0)
    .join('');

  return `Generate the morning briefing for today.

${body}`;
}

let anthropicClient: Anthropic | null = null;

export async function generateBriefing(
  emails: ClassifiedEmail[],
  stats: BriefingStats,
  calendar?: CalendarBriefingData,
  overnightDevSummary?: string,
  productionSummary?: string,
  userContext?: UserBriefingContext,
  pendingDevRequests?: string,
  adminOps?: AdminOpsSections,
  sections?: BriefingSectionFilter,
): Promise<string> {
  if (!anthropicClient) {
    const { config } = await import('../config.js');
    anthropicClient = new Anthropic({ apiKey: config.anthropic.apiKey });
  }
  const client = anthropicClient;
  const prompt = buildBriefingPrompt(emails, stats, calendar, overnightDevSummary, productionSummary, userContext, pendingDevRequests, adminOps, sections);
  const systemPrompt = getBriefingSystemPrompt(userContext);

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2000,
    system: systemPrompt,
    messages: [{ role: 'user', content: prompt }],
  });

  return response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');
}
