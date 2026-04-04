import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { config } from './config.js';
import { initializeSchema } from './db/schema.js';
// db/queries used by triage.ts directly
import { insertTimeLog, getTimeLogsForDate } from './db/time-queries.js';
import { runTriage } from './triage.js';
import { initBot, sendBriefing, sendCheckIn, sendMessage, sendEveningSummary } from './telegram/bot.js';
import { startScheduler, type ScheduledTask } from './scheduler.js';
import { TIMEZONE } from './calendar/types.js';
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

async function handleMorningBriefing(): Promise<void> {
  console.log('Running morning briefing...');
  try {
    const briefing = await runTriage(db);
    await sendBriefing(briefing);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Morning briefing failed:', msg);
    await sendMessage(`Morning briefing failed: ${msg}`, false).catch(() => {});
  }
}

async function handleHourlyCheckIn(): Promise<void> {
  awaitingCheckInResponse = true;
  await sendCheckIn();
}

async function handleEveningSummary(): Promise<void> {
  const today = getChicagoDate();
  const logs = getTimeLogsForDate(db, today);

  if (logs.length === 0) {
    await sendEveningSummary('No time entries logged today.');
    return;
  }

  const logList = logs
    .map((l) => `${l.hour}:00 — ${l.activity}${l.category !== 'untracked' ? ` (${l.category})` : ''}`)
    .join('\n');

  const summary = `*Time Log*\n${logList}\n\nTotal tracked hours: ${logs.length}`;
  await sendEveningSummary(summary);
}

async function handleIncomingMessage(text: string): Promise<string> {
  // Check if this is a time check-in response
  const hour = getChicagoHour();
  const today = getChicagoDate();

  // Simple heuristic: if the last message we sent was a check-in and this is a short response, log it as time
  const lowerText = text.toLowerCase().trim();

  // Direct commands
  if (lowerText === '/briefing' || lowerText === 'briefing' || lowerText.includes('briefing')) {
    try {
      const briefing = await runTriage(db);
      return briefing;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Briefing failed: ${msg}`;
    }
  }

  if (lowerText === '/status' || lowerText === 'status') {
    const logs = getTimeLogsForDate(db, today);
    if (logs.length === 0) return 'No time entries logged today.';
    return logs.map((l) => `${l.hour}:00 — ${l.activity}`).join('\n');
  }

  // Manual time log: "/log did accounting work"
  if (lowerText.startsWith('/log ')) {
    const activity = text.slice(5).trim();
    insertTimeLog(db, { date: today, hour: hour - 1, activity });
    return `Logged for ${hour - 1}:00: ${activity}`;
  }

  // If we sent a check-in and this is the response, log it as time
  if (awaitingCheckInResponse && text.length < 300 && !text.includes('?')) {
    awaitingCheckInResponse = false;
    insertTimeLog(db, { date: today, hour: hour - 1, activity: text.trim() });
    return `Logged for ${hour - 1}:00: ${text.trim()}`;
  }

  // For everything else, use Claude to generate a contextual response
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 500,
    system: `You are McSecretary, Rob McMillan's AI secretary. Rob owns Dearborn Denim (rob@dearborndenim.com) and McMillan Manufacturing (robert@mcmillan-manufacturing.com). Be concise, direct, and helpful. No emoji. Use Central Time.`,
    messages: [{ role: 'user', content: text }],
  });

  return response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

async function main() {
  console.log('McSECREtary starting up...');

  // Ensure data directory exists
  const dbDir = path.dirname(config.db.path);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  // Initialize database
  db = new Database(config.db.path);
  db.pragma('journal_mode = WAL');
  initializeSchema(db);

  // Initialize Anthropic client
  anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

  // Initialize Telegram bot
  const bot = await initBot();

  // Handle incoming messages
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
      // Use plain text to avoid Telegram Markdown parse errors
      await ctx.reply(response);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('Error handling message:', msg);
      await ctx.reply(`Error: ${msg}`);
    }
  });

  // Set up scheduled tasks (all times in America/Chicago)
  const tasks: ScheduledTask[] = [
    {
      name: 'Morning Briefing',
      schedule: '0 4 * * 1-5',  // 4 AM weekdays
      handler: handleMorningBriefing,
    },
    {
      name: 'Hourly Check-In',
      schedule: '0 7-15 * * 1-5',  // Every hour 7 AM - 3 PM weekdays
      handler: handleHourlyCheckIn,
    },
    {
      name: 'Evening Summary',
      schedule: '0 16 * * 1-5',  // 4 PM weekdays
      handler: handleEveningSummary,
    },
  ];

  startScheduler(tasks);

  // Start bot (long-polling)
  console.log('Starting Telegram bot...');
  bot.start({
    onStart: () => {
      console.log('McSECREtary is running. Telegram bot active, scheduler started.');
      console.log('Scheduled: Morning briefing at 4 AM, check-ins 7 AM-3 PM, evening summary at 4 PM (weekdays, Central Time)');
    },
  });

  // Handle graceful shutdown
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
