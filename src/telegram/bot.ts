import { Bot } from 'grammy';
import type Database from 'better-sqlite3';
import { getUserById } from '../db/user-queries.js';

let bot: Bot | null = null;
let botDb: Database.Database | null = null;

export function setBotDb(db: Database.Database): void {
  botDb = db;
}

export async function initBot(): Promise<Bot> {
  if (bot) return bot;

  const { config } = await import('../config.js');
  bot = new Bot(config.telegram.botToken);
  return bot;
}

export function getBot(): Bot {
  if (!bot) throw new Error('Bot not initialized. Call initBot() first.');
  return bot;
}

function getChatIdForUser(userId: string): string {
  if (!botDb) throw new Error('Bot DB not set. Call setBotDb() first.');
  const user = getUserById(botDb, userId);
  if (!user?.telegram_chat_id) throw new Error(`No Telegram chat linked for user ${userId}`);
  return user.telegram_chat_id;
}

export async function sendMessageToUser(userId: string, text: string, markdown: boolean = true): Promise<void> {
  const b = getBot();
  const chatId = getChatIdForUser(userId);

  if (!text || text.trim().length === 0) {
    console.warn('sendMessageToUser called with empty text, skipping');
    return;
  }

  const parseMode = markdown ? 'Markdown' : undefined;

  if (text.length <= 4096) {
    await b.api.sendMessage(chatId, text, { parse_mode: parseMode });
  } else {
    const chunks = splitMessage(text, 4096);
    for (const chunk of chunks) {
      await b.api.sendMessage(chatId, chunk, { parse_mode: parseMode });
    }
  }
}

// Legacy sendMessage for backward compat during transition — sends to a specific chatId
export async function sendMessage(text: string, markdown: boolean = true): Promise<void> {
  const b = getBot();
  const { config } = await import('../config.js');

  if (!text || text.trim().length === 0) {
    console.warn('sendMessage called with empty text, skipping');
    return;
  }

  // If botDb is set, try to find Robert's chat_id from DB; fall back to env var
  let chatId = config.telegram.chatId;
  if (botDb) {
    try {
      chatId = getChatIdForUser('robert-mcmillan');
    } catch {
      // fall back to env var
    }
  }

  if (!chatId) {
    console.warn('No chat_id available — message not sent');
    return;
  }

  const parseMode = markdown ? 'Markdown' : undefined;

  if (text.length <= 4096) {
    await b.api.sendMessage(chatId, text, { parse_mode: parseMode });
  } else {
    const chunks = splitMessage(text, 4096);
    for (const chunk of chunks) {
      await b.api.sendMessage(chatId, chunk, { parse_mode: parseMode });
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
  // - ## headers -> *bold* text
  // - ### headers -> *bold* text
  return briefing
    .replace(/^### (.+)$/gm, '*$1*')
    .replace(/^## (.+)$/gm, '*$1*')
    .replace(/^# (.+)$/gm, '*$1*');
}

export async function sendBriefingToUser(userId: string, briefing: string): Promise<void> {
  const formatted = formatBriefingForTelegram(briefing);
  await sendMessageToUser(userId, formatted);
}

// Legacy — sends to Robert
export async function sendBriefing(briefing: string): Promise<void> {
  const formatted = formatBriefingForTelegram(briefing);
  await sendMessage(formatted);
}

export async function sendCheckInToUser(userId: string): Promise<void> {
  const now = new Date();
  const hour = now.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/Chicago',
  });
  await sendMessageToUser(userId, `Quick check (${hour}) — what did you work on this past hour?`);
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

export async function sendEveningSummaryToUser(userId: string, summary: string): Promise<void> {
  await sendMessageToUser(userId, `*End of Day Summary*\n\n${summary}`);
}
