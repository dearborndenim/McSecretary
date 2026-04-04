import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { config } from './config.js';
import { initializeSchema } from './db/schema.js';
import { insertTimeLog, getTimeLogsForDate } from './db/time-queries.js';
import {
  insertConversationMessage,
  getRecentConversation,
  getConversationCount,
} from './db/conversation-queries.js';
import { runTriage } from './triage.js';
import { initBot, sendBriefing, sendCheckIn, sendMessage, sendEveningSummary } from './telegram/bot.js';
import { startScheduler, type ScheduledTask } from './scheduler.js';
import { TIMEZONE } from './calendar/types.js';
import { fetchRecentEmails, formatEmailsForContext } from './email/reader.js';
import {
  readMasterLearnings,
  readMasterPatterns,
  readSecretaryFile,
  getYesterdayDate,
  ensureJournalDirs,
} from './journal/files.js';
import Anthropic from '@anthropic-ai/sdk';

let db: Database.Database;
let anthropic: Anthropic;
let awaitingCheckInResponse = false;

function getChicagoDate(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE });
}

function getChicagoHour(): number {
  return parseInt(new Date().toLocaleTimeString('en-US', { hour: 'numeric', hour12: false, timeZone: TIMEZONE }));
}

function buildDailyContext(): string {
  const masterLearnings = readMasterLearnings();
  const masterPatterns = readMasterPatterns();
  const yesterday = getYesterdayDate(TIMEZONE);
  const yesterdayImprovements = readSecretaryFile(yesterday, 'improvements');
  const yesterdayReflection = readSecretaryFile(yesterday, 'reflection');

  let context = '';

  if (masterLearnings) {
    context += `\n\n=== WHAT I KNOW ABOUT ROB AND THE BUSINESSES ===\n${masterLearnings}`;
  }

  if (masterPatterns) {
    context += `\n\n=== HOW TO WORK WITH ROB ===\n${masterPatterns}`;
  }

  if (yesterdayImprovements) {
    context += `\n\n=== WHAT I WILL IMPROVE TODAY (from yesterday's reflection) ===\n${yesterdayImprovements}`;
  }

  if (yesterdayReflection) {
    context += `\n\n=== WHAT HAPPENED YESTERDAY ===\n${yesterdayReflection}`;
  }

  return context;
}

function buildConversationHistory(today: string): { role: 'user' | 'assistant'; content: string }[] {
  const count = getConversationCount(db, today);
  // If over 50 messages, only load last 30
  const messages = count > 50
    ? getRecentConversation(db, today, 30)
    : getRecentConversation(db, today, 50);

  return messages.map((m) => ({
    role: m.role === 'rob' ? 'user' as const : 'assistant' as const,
    content: m.message,
  }));
}

const SYSTEM_PROMPT_BASE = `You are McSecretary, Rob McMillan's AI chief of staff. You run 24/7 and manage his communications, schedule, and projects.

Rob owns two businesses:
- Dearborn Denim (rob@dearborndenim.com) — denim/jeans company, retail + wholesale
- McMillan Manufacturing (robert@mcmillan-manufacturing.com) — contract manufacturing

You have DIRECT ACCESS to Rob's email via Microsoft Graph API. You can read his inbox, calendar, and contacts. Never say "I don't have access" — you do.

Rules:
- Be direct, specific, and concise. No emoji.
- Use Central Time (Chicago) for all times.
- Reference actual data (email subjects, sender names) when answering.
- Remember everything from today's conversation.
- When Rob corrects you, acknowledge and learn from it.
- When Rob asks about email, ALWAYS check the actual email data provided below.
- "New customer emails" = responses to Apollo cold outreach campaigns.`;

async function handleMorningBriefing(): Promise<void> {
  console.log('Running morning briefing...');
  try {
    const briefing = await runTriage(db);
    await sendBriefing(briefing);
    // Log the briefing as a secretary message
    const today = getChicagoDate();
    insertConversationMessage(db, today, 'secretary', `[Morning Briefing]\n${briefing}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Morning briefing failed:', msg);
    await sendMessage(`Morning briefing failed: ${msg}`, false).catch(() => {});
  }
}

async function handleHourlyCheckIn(): Promise<void> {
  awaitingCheckInResponse = true;
  const checkInMsg = `Quick check — what did you work on this past hour?`;
  await sendCheckIn();
  const today = getChicagoDate();
  insertConversationMessage(db, today, 'secretary', checkInMsg);
}

async function handleEveningSummary(): Promise<void> {
  const today = getChicagoDate();
  const logs = getTimeLogsForDate(db, today);

  let summary: string;
  if (logs.length === 0) {
    summary = 'No time entries logged today.';
  } else {
    const logList = logs
      .map((l) => `${l.hour}:00 — ${l.activity}${l.category !== 'untracked' ? ` (${l.category})` : ''}`)
      .join('\n');
    summary = `Time Log:\n${logList}\n\nTotal tracked hours: ${logs.length}`;
  }

  const fullMsg = `End of Day Summary\n\n${summary}\n\nHow was your day? Anything you want to reflect on?`;
  await sendMessage(fullMsg, false);
  insertConversationMessage(db, today, 'secretary', fullMsg);
}

async function handleIncomingMessage(text: string): Promise<string> {
  const hour = getChicagoHour();
  const today = getChicagoDate();
  const lowerText = text.toLowerCase().trim();

  // Store Rob's message
  insertConversationMessage(db, today, 'rob', text);

  // Direct commands
  if (lowerText === '/briefing' || lowerText === 'briefing') {
    try {
      const briefing = await runTriage(db);
      insertConversationMessage(db, today, 'secretary', `[Briefing]\n${briefing}`);
      return briefing;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const errorMsg = `Briefing failed: ${msg}`;
      insertConversationMessage(db, today, 'secretary', errorMsg);
      return errorMsg;
    }
  }

  if (lowerText === '/status' || lowerText === 'status') {
    const logs = getTimeLogsForDate(db, today);
    const response = logs.length === 0
      ? 'No time entries logged today.'
      : logs.map((l) => `${l.hour}:00 — ${l.activity}`).join('\n');
    insertConversationMessage(db, today, 'secretary', response);
    return response;
  }

  if (lowerText.startsWith('/log ')) {
    const activity = text.slice(5).trim();
    insertTimeLog(db, { date: today, hour: hour - 1, activity });
    const response = `Logged for ${hour - 1}:00: ${activity}`;
    insertConversationMessage(db, today, 'secretary', response);
    return response;
  }

  // Check-in response
  if (awaitingCheckInResponse && text.length < 300 && !text.includes('?')) {
    awaitingCheckInResponse = false;
    insertTimeLog(db, { date: today, hour: hour - 1, activity: text.trim() });
    const response = `Logged for ${hour - 1}:00: ${text.trim()}`;
    insertConversationMessage(db, today, 'secretary', response);
    return response;
  }

  // Full AI response with conversation memory + email context
  try {
    console.log('Fetching email context and building conversation...');

    const [emails1, emails2] = await Promise.all([
      fetchRecentEmails(config.outlook.email1, 48, 25).catch(() => []),
      fetchRecentEmails(config.outlook.email2, 48, 25).catch(() => []),
    ]);

    const emailContext = formatEmailsForContext([...emails1, ...emails2]);
    const dailyContext = buildDailyContext();
    const conversationHistory = buildConversationHistory(today);

    const systemPrompt = `${SYSTEM_PROMPT_BASE}
${dailyContext}

RECENT EMAILS (last 48 hours):
${emailContext}`;

    // Build messages array: conversation history + current message
    // The current message is already the last item from Rob, but we need
    // to exclude it from history since we'll add it as the final message
    const historyWithoutLast = conversationHistory.slice(0, -1);

    const messages: { role: 'user' | 'assistant'; content: string }[] = [
      ...historyWithoutLast,
      { role: 'user', content: text },
    ];

    // Ensure messages alternate correctly (required by Claude API)
    // If two consecutive messages have the same role, merge them
    const cleaned: { role: 'user' | 'assistant'; content: string }[] = [];
    for (const msg of messages) {
      if (cleaned.length > 0 && cleaned[cleaned.length - 1]!.role === msg.role) {
        cleaned[cleaned.length - 1]!.content += '\n\n' + msg.content;
      } else {
        cleaned.push({ ...msg });
      }
    }

    // Ensure first message is from user
    if (cleaned.length > 0 && cleaned[0]!.role !== 'user') {
      cleaned.shift();
    }

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      system: systemPrompt,
      messages: cleaned,
    });

    const responseText = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    // Store secretary's response
    insertConversationMessage(db, today, 'secretary', responseText);

    return responseText;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const errorMsg = `Failed to process request: ${msg}`;
    insertConversationMessage(db, today, 'secretary', errorMsg);
    return errorMsg;
  }
}

async function main() {
  console.log('McSECREtary starting up...');

  const dbDir = path.dirname(config.db.path);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  db = new Database(config.db.path);
  db.pragma('journal_mode = WAL');
  initializeSchema(db);

  ensureJournalDirs();

  anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

  const bot = await initBot();

  bot.on('message:text', async (ctx) => {
    const chatId = ctx.chat.id.toString();
    if (chatId !== config.telegram.chatId) {
      console.log(`Ignoring message from unauthorized chat: ${chatId}`);
      return;
    }

    const text = ctx.message.text;
    console.log(`Received message: ${text.slice(0, 50)}...`);

    try {
      const response = await handleIncomingMessage(text);
      if (!response || response.trim().length === 0) {
        await ctx.reply('No response generated. Try again or use "briefing" for a full briefing.');
        return;
      }
      await ctx.reply(response);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('Error handling message:', msg);
      await ctx.reply(`Error: ${msg}`);
    }
  });

  const tasks: ScheduledTask[] = [
    {
      name: 'Morning Briefing',
      schedule: '0 4 * * 1-5',
      handler: handleMorningBriefing,
    },
    {
      name: 'Hourly Check-In',
      schedule: '0 7-15 * * 1-5',
      handler: handleHourlyCheckIn,
    },
    {
      name: 'Evening Summary',
      schedule: '0 16 * * 1-5',
      handler: handleEveningSummary,
    },
  ];

  startScheduler(tasks);

  console.log('Starting Telegram bot...');
  bot.start({
    onStart: () => {
      console.log('McSECREtary is running. Telegram bot active, scheduler started.');
      console.log('Scheduled: Morning briefing at 4 AM, check-ins 7 AM-3 PM, evening summary at 4 PM (weekdays, Central Time)');
    },
  });

  const shutdown = () => {
    console.log('Shutting down...');
    bot.stop();
    db.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('McSECREtary crashed:', err);
  process.exit(1);
});
