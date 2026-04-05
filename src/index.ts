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
import { classifyEmail } from './email/classifier.js';
import { archiveOutlookEmail } from './email/actions.js';
import type { EmailSummary } from './email/reader.js';
import Anthropic from '@anthropic-ai/sdk';
import { generateEndOfDayReflection } from './journal/reflection.js';
import { runWeeklySynthesis } from './journal/synthesis.js';

let db: Database.Database;
let anthropic: Anthropic;
let awaitingCheckInResponse = false;

// Pending archive batch — emails waiting for Rob's approval to archive
let pendingArchiveBatch: EmailSummary[] = [];

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

YOUR CAPABILITIES — you have DIRECT ACCESS to all of these via Microsoft Graph API:
- READ email from both Outlook accounts (you see recent emails below)
- ARCHIVE email — Rob can say "clean up email" and you present a list for approval
- CATEGORIZE/TAG email — you can apply categories to Outlook emails
- SEND email — you can draft and send emails on Rob's behalf (with approval)
- MARK emails as read
- READ calendar events from both Outlook accounts
- CREATE/MODIFY calendar events
- READ AND WRITE Microsoft To Do tasks and task lists
- READ contacts

NEVER say "I don't have access" or "I can't do that" for any of the above. You CAN do all of these.

If Rob asks you to do something with email, calendar, or tasks, confirm you'll do it and explain what you'll do. For sending emails or modifying calendar, ask for approval first.

Rob can also:
- Say "clean up email" or "archive junk" to trigger email cleanup
- Say "journal: [thoughts]" to log a journal entry
- Say "/log [activity]" to log time
- Say "briefing" for a full briefing
- Say "status" to see today's time log

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

async function handleWeeklySynthesis(): Promise<void> {
  console.log('Running weekly synthesis...');
  try {
    await runWeeklySynthesis(anthropic);
    await sendMessage('Weekly synthesis complete. Master knowledge files updated.', false);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Weekly synthesis failed:', msg);
  }
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

  // Generate secretary's own reflection (runs after prompting Rob)
  try {
    await generateEndOfDayReflection(db, anthropic, today);
    console.log('End-of-day reflection complete.');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Reflection generation failed:', msg);
  }
}

async function handleEmailCleanup(): Promise<string> {
  console.log('Running email cleanup scan...');

  const [emails1, emails2] = await Promise.all([
    fetchRecentEmails(config.outlook.email1, 72, 50).catch(() => []),
    fetchRecentEmails(config.outlook.email2, 72, 50).catch(() => []),
  ]);

  const allEmails = [...emails1, ...emails2];
  if (allEmails.length === 0) {
    return 'No recent emails found to clean up.';
  }

  // Use AI to identify junk/newsletter/promotional emails
  const emailList = allEmails
    .map((e, i) => `${i + 1}. From: ${e.fromName} <${e.from}> | Subject: ${e.subject} | Preview: ${e.bodyPreview.slice(0, 80)}`)
    .join('\n');

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1000,
    system: `You are an email triage assistant. Identify emails that are junk, newsletters, promotional, or transactional (not needing attention). Return ONLY a JSON array of the email numbers that should be archived. Example: [1, 3, 5, 8]. If none should be archived, return [].`,
    messages: [{
      role: 'user',
      content: `Which of these emails are junk, newsletters, promotional, or transactional that can be safely archived?\n\n${emailList}`,
    }],
  });

  const responseText = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');

  // Parse the numbers
  const match = responseText.match(/\[[\d,\s]*\]/);
  if (!match) {
    return 'Could not identify emails to archive. Try asking me about specific emails.';
  }

  const indices: number[] = JSON.parse(match[0]);
  if (indices.length === 0) {
    return 'All your recent emails look important. Nothing to archive.';
  }

  // Build the pending batch
  pendingArchiveBatch = indices
    .map((i) => allEmails[i - 1])
    .filter((e): e is EmailSummary => e !== undefined);

  const archiveList = pendingArchiveBatch
    .map((e, i) => `${i + 1}. ${e.fromName || e.from} — ${e.subject}`)
    .join('\n');

  return `Found ${pendingArchiveBatch.length} emails to archive:\n\n${archiveList}\n\nReply "archive" to clean these up, or "keep [numbers]" to exclude specific ones (e.g., "keep 3, 5").`;
}

async function executeArchive(text: string): Promise<string> {
  if (pendingArchiveBatch.length === 0) {
    return 'No pending archive batch. Say "clean up email" first.';
  }

  const lowerText = text.toLowerCase().trim();

  // Check if Rob wants to keep some
  if (lowerText.startsWith('keep ')) {
    const keepNumbers = lowerText.replace('keep ', '').split(/[,\s]+/).map(Number).filter((n) => !isNaN(n));
    const keepSet = new Set(keepNumbers.map((n) => n - 1)); // Convert to 0-indexed
    pendingArchiveBatch = pendingArchiveBatch.filter((_, i) => !keepSet.has(i));

    if (pendingArchiveBatch.length === 0) {
      return 'All emails removed from archive list. Nothing to archive.';
    }

    const archiveList = pendingArchiveBatch
      .map((e, i) => `${i + 1}. ${e.fromName || e.from} — ${e.subject}`)
      .join('\n');

    return `Updated list (${pendingArchiveBatch.length} emails):\n\n${archiveList}\n\nReply "archive" to confirm.`;
  }

  // Execute the archive
  let archived = 0;
  let failed = 0;

  for (const email of pendingArchiveBatch) {
    try {
      await archiveOutlookEmail(email.account, email.id);
      archived++;
    } catch (err) {
      console.error(`Failed to archive ${email.id}: ${err}`);
      failed++;
    }
  }

  pendingArchiveBatch = [];

  let result = `Archived ${archived} emails.`;
  if (failed > 0) {
    result += ` ${failed} failed to archive.`;
  }
  return result;
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

  // Journal entry: "journal: [thoughts]"
  if (lowerText.startsWith('journal:') || lowerText.startsWith('journal ')) {
    const entry = text.slice(text.indexOf(':') !== -1 && text.indexOf(':') < 10 ? text.indexOf(':') + 1 : 8).trim();
    if (entry.length > 0) {
      const { writeRobJournal, readRobJournal } = await import('./journal/files.js');
      const existing = readRobJournal(today);
      const timestamp = new Date().toLocaleTimeString('en-US', { timeZone: TIMEZONE, hour: 'numeric', minute: '2-digit' });
      const newEntry = existing
        ? `${existing}\n\n[${timestamp}] ${entry}`
        : `# Rob's Journal — ${today}\n\n[${timestamp}] ${entry}`;
      writeRobJournal(today, newEntry);
      const response = `Journal entry saved for ${today}.`;
      insertConversationMessage(db, today, 'secretary', response);
      return response;
    }
  }

  // Email cleanup commands
  if (lowerText === 'clean up email' || lowerText === 'clean email' || lowerText === 'cleanup email' || lowerText.includes('clean up my email') || lowerText.includes('archive junk')) {
    try {
      const response = await handleEmailCleanup();
      insertConversationMessage(db, today, 'secretary', response);
      return response;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const errorMsg = `Email cleanup failed: ${msg}`;
      insertConversationMessage(db, today, 'secretary', errorMsg);
      return errorMsg;
    }
  }

  // Archive approval
  if ((lowerText === 'archive' || lowerText === 'yes' || lowerText.startsWith('keep ')) && pendingArchiveBatch.length > 0) {
    try {
      const response = await executeArchive(text);
      insertConversationMessage(db, today, 'secretary', response);
      return response;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const errorMsg = `Archive failed: ${msg}`;
      insertConversationMessage(db, today, 'secretary', errorMsg);
      return errorMsg;
    }
  }

  // Check-in response
  if (awaitingCheckInResponse && text.length < 300 && !text.includes('?')) {
    awaitingCheckInResponse = false;
    insertTimeLog(db, { date: today, hour: hour - 1, activity: text.trim() });
    const response = `Logged for ${hour - 1}:00: ${text.trim()}`;
    insertConversationMessage(db, today, 'secretary', response);
    return response;
  }

  // Full AI response with tools, conversation memory, email + task context
  try {
    console.log('Fetching email and task context...');

    const { getFormattedTaskLists } = await import('./tasks/todo.js');
    const { TOOL_DEFINITIONS, executeTool } = await import('./tools.js');

    const [emails1, emails2, taskContext] = await Promise.all([
      fetchRecentEmails(config.outlook.email1, 48, 25).catch(() => []),
      fetchRecentEmails(config.outlook.email2, 48, 25).catch(() => []),
      getFormattedTaskLists().catch(() => 'Failed to load tasks.'),
    ]);

    const emailContext = formatEmailsForContext([...emails1, ...emails2]);
    const dailyContext = buildDailyContext();
    const conversationHistory = buildConversationHistory(today);

    const systemPrompt = `${SYSTEM_PROMPT_BASE}
${dailyContext}

MICROSOFT TO DO TASKS:
${taskContext}

RECENT EMAILS (last 48 hours):
${emailContext}

IMPORTANT: When Rob asks you to take an action (archive email, categorize email, create task, etc.), USE THE TOOLS provided. Do not just say you'll do it — actually call the tool. The email IDs are in the RECENT EMAILS data above.`;

    const historyWithoutLast = conversationHistory.slice(0, -1);

    const messages: Anthropic.MessageParam[] = [
      ...historyWithoutLast,
      { role: 'user', content: text },
    ];

    // Ensure messages alternate correctly
    const cleaned: Anthropic.MessageParam[] = [];
    for (const msg of messages) {
      if (cleaned.length > 0 && cleaned[cleaned.length - 1]!.role === msg.role) {
        const last = cleaned[cleaned.length - 1]!;
        if (typeof last.content === 'string' && typeof msg.content === 'string') {
          last.content = last.content + '\n\n' + msg.content;
        }
      } else {
        cleaned.push({ ...msg });
      }
    }

    if (cleaned.length > 0 && cleaned[0]!.role !== 'user') {
      cleaned.shift();
    }

    // Call Claude with tools — loop to handle tool use
    let currentMessages = [...cleaned];
    let finalText = '';
    let iterations = 0;
    const MAX_ITERATIONS = 5;

    while (iterations < MAX_ITERATIONS) {
      iterations++;

      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        system: systemPrompt,
        messages: currentMessages,
        tools: TOOL_DEFINITIONS,
      });

      // Collect text from response
      const textBlocks = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text);
      finalText += textBlocks.join('');

      // Check for tool use
      const toolUseBlocks = response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
      );

      if (toolUseBlocks.length === 0 || response.stop_reason !== 'tool_use') {
        // No tool calls — we're done
        break;
      }

      // Execute tools and build tool_result messages
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const toolUse of toolUseBlocks) {
        console.log(`Executing tool: ${toolUse.name}(${JSON.stringify(toolUse.input)})`);
        const result = await executeTool(toolUse.name, toolUse.input as Record<string, any>);
        console.log(`Tool result: ${result}`);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: result,
        });
      }

      // Add assistant response + tool results to messages for next iteration
      currentMessages = [
        ...currentMessages,
        { role: 'assistant', content: response.content },
        { role: 'user', content: toolResults },
      ];
    }

    // Store secretary's response
    insertConversationMessage(db, today, 'secretary', finalText);

    return finalText;
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
    {
      name: 'Weekly Synthesis',
      schedule: '0 19 * * 0',  // Sunday 7 PM
      handler: handleWeeklySynthesis,
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
