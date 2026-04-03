import Anthropic from '@anthropic-ai/sdk';
import type { ClassifiedEmail } from '../email/types.js';

const BRIEFING_SYSTEM_PROMPT = `You are Rob McMillan's AI secretary generating his morning briefing.

Rob owns Dearborn Denim (rob@dearborndenim.com) and McMillan Manufacturing (robert@mcmillan-manufacturing.com). His personal email is mcmillanrken@gmail.com.

Generate a concise, actionable morning briefing in markdown format. Structure:

1. **Needs Your Attention** — Critical/high urgency items requiring a response. Include sender, one-line summary, and suggested action.
2. **For Your Review** — Medium priority items to look at when time allows.
3. **FYI / Handled** — What was auto-archived or marked as informational.
4. **Stats** — How many emails processed, archived, flagged.

Keep it conversational but direct. Rob is busy — lead with what matters.
Don't use emoji.`;

export interface BriefingStats {
  totalProcessed: number;
  archived: number;
  flaggedForReview: number;
}

export function buildBriefingPrompt(
  emails: ClassifiedEmail[],
  stats: BriefingStats,
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

  return `Generate the morning briefing for today.

Stats:
- Total emails processed: ${stats.totalProcessed}
- Auto-archived: ${stats.archived}
- Flagged for review: ${stats.flaggedForReview}

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
): Promise<string> {
  if (!anthropicClient) {
    const { config } = await import('../config.js');
    anthropicClient = new Anthropic({ apiKey: config.anthropic.apiKey });
  }
  const client = anthropicClient;
  const prompt = buildBriefingPrompt(emails, stats);

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
