import { Bot } from 'grammy';

let bot: Bot | null = null;
let chatId: string | null = null;

export async function initBot(): Promise<Bot> {
  if (bot) return bot;

  const { config } = await import('../config.js');
  chatId = config.telegram.chatId;
  bot = new Bot(config.telegram.botToken);
  return bot;
}

export function getBot(): Bot {
  if (!bot) throw new Error('Bot not initialized. Call initBot() first.');
  return bot;
}

export function getChatId(): string {
  if (!chatId) throw new Error('Bot not initialized. Call initBot() first.');
  return chatId;
}

export async function sendMessage(text: string): Promise<void> {
  const b = getBot();
  const id = getChatId();

  // Telegram has a 4096 character limit per message
  if (text.length <= 4096) {
    await b.api.sendMessage(id, text, { parse_mode: 'Markdown' });
  } else {
    // Split into chunks at newline boundaries
    const chunks = splitMessage(text, 4096);
    for (const chunk of chunks) {
      await b.api.sendMessage(id, chunk, { parse_mode: 'Markdown' });
    }
  }
}

function splitMessage(text: string, maxLength: number): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Find last newline within limit
    let splitAt = remaining.lastIndexOf('\n', maxLength);
    if (splitAt <= 0) {
      // No newline found, hard split
      splitAt = maxLength;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt + 1);
  }

  return chunks;
}

export function formatBriefingForTelegram(briefing: string): string {
  // The briefing comes as markdown from Claude. Telegram supports a subset of Markdown.
  // Replace unsupported markdown:
  // - ## headers → *bold* text
  // - ### headers → *bold* text
  return briefing
    .replace(/^### (.+)$/gm, '*$1*')
    .replace(/^## (.+)$/gm, '*$1*')
    .replace(/^# (.+)$/gm, '*$1*');
}

export async function sendBriefing(briefing: string): Promise<void> {
  const formatted = formatBriefingForTelegram(briefing);
  await sendMessage(formatted);
}

export async function sendCheckIn(): Promise<void> {
  const now = new Date();
  const hour = now.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/Chicago',
  });
  await sendMessage(`Quick check (${hour}) — what did you work on this past hour?`);
}

export async function sendEveningSummary(summary: string): Promise<void> {
  await sendMessage(`*End of Day Summary*\n\n${summary}`);
}
