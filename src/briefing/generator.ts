import Anthropic from '@anthropic-ai/sdk';
import type { ClassifiedEmail } from '../email/types.js';
import type { CalendarBriefingData } from '../calendar/types.js';

const BRIEFING_SYSTEM_PROMPT = `You are Rob McMillan's AI secretary generating his morning briefing.

Rob owns Dearborn Denim (rob@dearborndenim.com) and McMillan Manufacturing (robert@mcmillan-manufacturing.com). His personal email is mcmillanrken@gmail.com.

Generate a concise, actionable morning briefing in markdown format. Structure:

1. **Today's Schedule** — Calendar events for today with times (Chicago time), conflicts flagged with suggestions, and free time blocks. Only include if calendar data is provided.
2. **Needs Your Attention** — Critical/high urgency email items requiring a response. Include sender, one-line summary, and suggested action.
3. **For Your Review** — Medium priority items to look at when time allows.
4. **FYI / Handled** — What was auto-archived or marked as informational.
5. **Stats** — How many emails processed, archived, flagged.

Keep it conversational but direct. Rob is busy — lead with what matters.
Don't use emoji. Use Central Time (Chicago) for all times.`;

export interface BriefingStats {
  totalProcessed: number;
  archived: number;
  flaggedForReview: number;
}

export function buildBriefingPrompt(
  emails: ClassifiedEmail[],
  stats: BriefingStats,
  calendar?: CalendarBriefingData,
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
  if (calendar) {
    const eventList = calendar.events.length === 0
      ? 'No events scheduled.'
      : calendar.events
          .map((e) => `- ${e.startTime} to ${e.endTime}: ${e.title} (${e.calendarEmail})${e.location ? ` — ${e.location}` : ''}`)
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

  return `Generate the morning briefing for today.

Stats:
- Total emails processed: ${stats.totalProcessed}
- Auto-archived: ${stats.archived}
- Flagged for review: ${stats.flaggedForReview}
${calendarSection}
CRITICAL urgency:
${formatEmails(critical)}

HIGH urgency:
${formatEmails(high)}

MEDIUM urgency:
${formatEmails(medium)}

LOW urgency:
${formatEmails(low)}`;
}

let anthropicClient: Anthropic | null = null;

export async function generateBriefing(
  emails: ClassifiedEmail[],
  stats: BriefingStats,
  calendar?: CalendarBriefingData,
): Promise<string> {
  if (!anthropicClient) {
    const { config } = await import('../config.js');
    anthropicClient = new Anthropic({ apiKey: config.anthropic.apiKey });
  }
  const client = anthropicClient;
  const prompt = buildBriefingPrompt(emails, stats, calendar);

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6-20250514',
    max_tokens: 2000,
    system: BRIEFING_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: prompt }],
  });

  return response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');
}
