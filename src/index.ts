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
import {
  initBot,
  setBotDb,
  sendBriefing,
  sendBriefingToUser,
  sendCheckIn,
  sendCheckInToUser,
  sendMessage,
  sendMessageToUser,
  sendEveningSummary,
  sendEveningSummaryToUser,
} from './telegram/bot.js';
import { initializeDefaultSchedule, startSchedulerFromDb, stopAllJobs, registerHandler } from './scheduler.js';
import { createShutdown } from './shutdown.js';
import { TIMEZONE } from './calendar/types.js';
import { fetchRecentEmails, formatEmailsForContext, toRawEmail } from './email/reader.js';
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
import {
  initApi,
  startApiServer,
  getRecentSmsMessages,
  setBriefingPreviewCacheProvider,
  setSpineHttpHandler,
  setLionsHttpHandler,
  setRfqFilesHttpHandler,
} from './api.js';
import { createLionsRouter } from './lions/routes.js';
import { runLionsCheck, formatScheduleForTelegram } from './lions/check.js';
import { getActiveAlerts, getLatestSnapshot } from './lions/store.js';
import { lionsConfig } from './lions/config.js';
import { buildSpine } from './spine/wiring.js';
import { createTelegramTransport } from './spine/telegram-card.js';
import { parseAgentKeys } from './spine/agent-keys.js';
import { getGraphToken } from './auth/graph.js';
import { setRfqIntakeHandler, processRfqReply, getRfqIntakeHandler, intakeRfqRepliesFrom, type RfqScanSummary } from './email/rfq-intake.js';
import { createRfqFilesRouter, rfqFilesDir } from './email/rfq-files.js';
import { extractRfqOptions, saveRfqAttachments, postVendorQuote, sendRfqAcknowledgement } from './email/rfq-runtime.js';
import { insertEvent } from './db/event-queries.js';
import { runExpirySweep, buildTrustMonthlySummary } from './spine/jobs.js';
import { seedRobert, ROBERT_ID } from './db/seed-robert.js';
import { seedTeam } from './db/seed-team.js';
import {
  getUserByTelegramChatId,
  getUserById,
  getUserByEmail,
  getActiveUsers,
  consumeInvite,
  linkTelegramChat,
  getUserEmailAccounts,
  getUserPreferences,
  createInvite,
} from './db/user-queries.js';
import type { User } from './db/user-queries.js';
import {
  insertDevRequest,
  getDevRequestsByUser,
  getPendingDevRequests,
  getDevRequestById,
  approveDevRequest,
  rejectDevRequest,
} from './db/request-queries.js';
import { shouldUserCheckInNow, shouldUserEodNow } from './scheduler-windows.js';
import { getTomorrowEventsPreview } from './calendar/tomorrow-preview.js';
import { buildChatSystemBlocks } from './chat-prompt.js';
import {
  EMAIL_SCAN_OUTPUT_FORMAT,
  parseEmailScanResponse,
  CLEANUP_OUTPUT_FORMAT,
  CLEANUP_SYSTEM_PROMPT,
  parseCleanupResponse,
} from './email/scan-schemas.js';

let db: Database.Database;
let anthropic: Anthropic;
let awaitingCheckInResponse = false;
// Per-user flag: expecting Rob/member's reply to the EOD reflection prompt.
// Cleared when they respond (which is saved as a journal entry).
const awaitingReflectionFromUser = new Set<string>();

// Pending archive batch — emails waiting for Rob's approval to archive
let pendingArchiveBatch: EmailSummary[] = [];

// Task polling — last known state for change detection
let lastTaskSnapshot: Map<string, { listName: string; taskId: string; title: string; status: string }> = new Map();

// Briefing-preview cache (Briefing UX Polish 7 — 2026-04-29).
// Lazy-built on first use so module load stays light. Honors
// `DISABLE_BRIEFING_PREVIEW_CACHE=1` (returns no-op shim) and
// `BRIEFING_PREVIEW_CACHE_TTL_SECONDS` (default 300).
let _briefingPreviewCache: import('./briefing/preview-cache.js').BriefingPreviewCache | undefined;
async function getBriefingPreviewCache(): Promise<
  import('./briefing/preview-cache.js').BriefingPreviewCache
> {
  if (_briefingPreviewCache) return _briefingPreviewCache;
  const { buildBriefingPreviewCache } = await import('./briefing/preview-cache.js');
  _briefingPreviewCache = buildBriefingPreviewCache();
  return _briefingPreviewCache;
}

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

function buildConversationHistory(userId: string, today: string): { role: 'user' | 'assistant'; content: string }[] {
  const count = getConversationCount(db, userId, today);
  // If over 50 messages, only load last 30
  const messages = count > 50
    ? getRecentConversation(db, userId, today, 30)
    : getRecentConversation(db, userId, today, 50);

  return messages.map((m) => ({
    role: m.role === 'rob' ? 'user' as const : 'assistant' as const,
    content: m.message,
  }));
}

async function handleMorningBriefing(): Promise<void> {
  console.log('Running morning briefings for all users...');

  const users = getActiveUsers(db);

  for (const user of users) {
    try {
      // Generate reflection for admin only (Robert)
      if (user.role === 'admin') {
        const yesterday = getYesterdayDate(TIMEZONE);
        try {
          const result = await generateEndOfDayReflection(db, anthropic, yesterday);
          if (result === 'completed') {
            console.log(`Yesterday's reflection (${yesterday}) complete.`);
            await sendMessageToUser(user.id, 'Daily reflection complete. 3 files written. Master knowledge will update Sunday.', false);
          } else {
            console.log(`No activity found for ${yesterday} — reflection skipped.`);
            await sendMessageToUser(user.id, 'No activity yesterday — reflection skipped.', false);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error('Reflection generation failed:', msg);
          await sendMessageToUser(user.id, `Reflection failed: ${msg}`, false).catch(() => {});
        }
      }

      // Per-user briefing-section preference (Task 7, 2026-04-22). NULL →
      // render all sections (legacy behavior). When set, only the stored
      // subset renders. Invalid / malformed JSON falls back to all sections
      // because `getUserBriefingSections` returns null on parse failure.
      const { getUserBriefingSections } = await import('./db/user-queries.js');
      const { isValidBriefingSection } = await import('./briefing/sections.js');
      const storedSections = getUserBriefingSections(db, user.id);
      const validated = storedSections
        ? storedSections.filter(isValidBriefingSection)
        : null;
      const sectionsOpt = validated && validated.length > 0 ? { sections: validated } : undefined;
      const briefing = await runTriage(db, user.id, sectionsOpt);
      await sendBriefingToUser(user.id, briefing);
      const today = getChicagoDate();
      insertConversationMessage(db, user.id, today, 'secretary', `[Morning Briefing]\n${briefing}`);
      console.log(`Briefing sent to ${user.name}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Morning briefing failed for ${user.name}: ${msg}`);
      await sendMessageToUser(user.id, `Morning briefing failed: ${msg}`, false).catch(() => {});
    }
  }
}

async function handleHourlyCheckIn(): Promise<void> {
  const users = getActiveUsers(db);
  const now = new Date();
  let anySent = false;
  for (const user of users) {
    // Each user has their own schedule window; skip if this isn't their slot.
    if (!shouldUserCheckInNow(db, user.id, now)) continue;

    try {
      await sendCheckInToUser(user.id);
      const today = getChicagoDate();
      insertConversationMessage(db, user.id, today, 'secretary', 'Quick check — what did you work on this past hour?');
      anySent = true;
    } catch (err) {
      console.error(`Check-in failed for ${user.name}: ${(err as Error).message}`);
    }
  }
  if (anySent) awaitingCheckInResponse = true;
}

async function handleWeeklySynthesis(): Promise<void> {
  console.log('Running weekly synthesis...');
  try {
    await runWeeklySynthesis(anthropic);
    await sendMessage('Weekly synthesis complete. Master knowledge files updated.', false);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Weekly synthesis failed:', msg);
    await sendMessage(`Weekly synthesis failed: ${msg}`, false).catch(() => {});
  }
}

async function handleTaskPolling(): Promise<void> {
  try {
    const { getAllTasksSnapshot, diffTaskSnapshots } = await import('./tasks/todo.js');
    const currentSnapshot = await getAllTasksSnapshot();

    if (lastTaskSnapshot.size > 0) {
      const diff = diffTaskSnapshots(lastTaskSnapshot, currentSnapshot);

      if (diff.completed.length > 0) {
        const today = getChicagoDate();
        const hour = getChicagoHour();

        for (const task of diff.completed) {
          // Log completed task as time entry — task polling is admin (Robert) only for now
          insertTimeLog(db, ROBERT_ID, {
            date: today,
            hour: hour,
            activity: `Completed: ${task.title} (${task.listName})`,
            category: 'task_completed',
          });
        }

        const completedList = diff.completed.map((t) => `- ${t.title} (${t.listName})`).join('\n');
        const msg = `Tasks completed:\n${completedList}`;
        console.log(msg);
        await sendMessage(msg, false);
        insertConversationMessage(db, ROBERT_ID, today, 'secretary', `[Task Update] ${msg}`);
      }

      if (diff.created.length > 0) {
        console.log(`New tasks detected: ${diff.created.map((t) => t.title).join(', ')}`);
      }
    }

    lastTaskSnapshot = currentSnapshot;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Task polling failed:', msg);
  }
}

/**
 * Daily 7 AM CT job — summarize the last 24h of /briefing-sections preference
 * changes. Empty result → silent (no message). Populated result → message is
 * delivered to the admin (Telegram by default, or to BRIEFING_AUDIT_DIGEST_RECIPIENT
 * when set as an email address — wiring TBD; for now we always log + Telegram).
 * Opt-out via `DISABLE_BRIEFING_AUDIT_DIGEST=1`.
 */
async function handleBriefingSectionsAuditDigest(): Promise<void> {
  console.log('Running briefing-sections audit digest...');
  try {
    const { runBriefingSectionsAuditDigest } = await import(
      './briefing/sections-audit-digest.js'
    );
    const result = runBriefingSectionsAuditDigest(db);
    if (!result.ran || result.message === null) {
      console.log(`Briefing-audit digest skipped: ${result.reason ?? 'unknown'}`);
      return;
    }
    const recipient = process.env.BRIEFING_AUDIT_DIGEST_RECIPIENT ?? '';
    const header = `[Briefing-sections audit — last 24h]`;
    const body = `${header}\n${result.message}`;
    console.log(body);
    if (recipient.length > 0) {
      // Recipient configured — send via Telegram broadcast (admin chat). The
      // explicit recipient knob lets ops route to a different surface later
      // (e.g. a dedicated audit channel) without code changes.
      await sendMessage(body, false).catch(() => {});
    } else {
      // No recipient → log only. Safe default for new deploys.
      console.log('BRIEFING_AUDIT_DIGEST_RECIPIENT unset — log-only.');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Briefing-audit digest failed:', msg);
  }
}

async function handleSpineSweep(): Promise<void> {
  const report = runExpirySweep(db, new Date().toISOString());
  if (!report) return;
  try { await sendMessageToUser(config.spine.monthlySummaryUserId, report, false); }
  catch (err) { console.error('Spine sweep report failed:', err); }
}

async function handleTrustMonthlySummary(): Promise<void> {
  const since = new Date(); since.setUTCMonth(since.getUTCMonth() - 1);
  const summary = buildTrustMonthlySummary(db, since.toISOString());
  if (!summary) return;
  try { await sendMessageToUser(config.spine.monthlySummaryUserId, summary, false); }
  catch (err) { console.error('Trust summary failed:', err); }
}

/**
 * South Loop Lions schedule check (see src/lions/). Runs on its own cron
 * entries; the check itself owns the Telegram alert, so this wrapper only logs.
 */
async function handleLionsCheck(): Promise<void> {
  const result = await runLionsCheck({ db });
  if (!result.ok) {
    console.error(`Lions schedule check failed: ${result.error}`);
    return;
  }
  if (result.baseline) {
    console.log(`Lions schedule check: baseline stored (${result.games} games)`);
    return;
  }
  console.log(
    `Lions schedule check: sheetChanged=${result.sheetChanged} changes=${result.changes.length} notified=${result.notified}`,
  );
}

async function handleInviteReminders(): Promise<void> {
  console.log('Running 48h invite reminders...');
  try {
    const { runInviteReminders, defaultReminderManifestPath, formatReminderSummary } =
      await import('./onboarding/reminder.js');
    const result = await runInviteReminders(db, {
      manifestPath: defaultReminderManifestPath(),
    });
    const summary = formatReminderSummary(result);
    console.log(summary);
    // Only notify admin when we actually sent a reminder — skip quiet runs.
    const anyReminded = result.processed.some(
      (p) => p.status === 'reminded' || p.status === 'reminded_stubbed',
    );
    if (anyReminded) {
      await sendMessage(summary, false).catch(() => {});
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Invite reminder job failed:', msg);
  }
}

/**
 * Run the RFQ reply matcher/intake (spec §12.3) over a batch of already-fetched
 * `EmailSummary` rows. Shared by the 30-minute Email Scan job and the "scan rfq"
 * Telegram command — both need the reply intake to run outside the 5 AM
 * triage, and both are idempotent per inbound message id via `rfq_replies`
 * (`intakeRfqRepliesFrom`), so running this twice over the same message, or
 * once here and once in `runTriage`, files nothing twice.
 *
 * Returns null with no intake handler registered yet (startup ordering, or
 * an admin/test context where `setRfqIntakeHandler` was never called).
 */
async function runRfqScan(messages: EmailSummary[]): Promise<RfqScanSummary | null> {
  const handler = getRfqIntakeHandler();
  if (!handler) return null;
  const rawEmails = messages.filter((e) => e.body !== undefined).map(toRawEmail);
  return intakeRfqRepliesFrom(rawEmails, { db, now: () => new Date().toISOString(), handler, env: process.env });
}

async function handleEmailScan(): Promise<void> {
  try {
    console.log('Scanning emails for auto-tagging...');

    // Fetch emails from all users' email accounts
    const allUsers = getActiveUsers(db);
    const allEmailAddresses = allUsers.flatMap((u) =>
      getUserEmailAccounts(db, u.id).map((a) => a.email_address),
    );

    // includeBody: true — the RFQ matcher below only needs subject/sender/preview,
    // but a matched reply's extraction (spec §12.3) needs the full body, and
    // fetching it lazily per-match would mean a second Graph round trip per
    // vendor reply. Fetching it up front here is one extra field on a call
    // that already runs every 30 minutes over a small (≤30/account) window.
    const emailResults = await Promise.all(
      allEmailAddresses.map((email) => fetchRecentEmails(email, 4, 30, true).catch(() => [])),
    );

    // Only process untagged emails (no Outlook categories yet)
    const untagged = emailResults.flat().filter((e) => e.categories.length === 0);

    if (untagged.length === 0) {
      console.log('No untagged emails found.');
      return;
    }

    console.log(`Found ${untagged.length} untagged emails to classify.`);

    const emailList = untagged.map((e, i) =>
      `${i + 1}. ID: ${e.id} | Account: ${e.account} | From: ${e.fromName} <${e.from}> | Subject: ${e.subject} | Preview: ${e.bodyPreview.slice(0, 100)}`
    ).join('\n');

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      output_config: { effort: 'low', format: EMAIL_SCAN_OUTPUT_FORMAT },
      system: `You are an email triage assistant for Rob McMillan, owner of Dearborn Denim (rob@dearborndenim.com) and McMillan Manufacturing (robert@mcmillan-manufacturing.com).
For each email decide whether it is spam.

Mark as spam (true) if the email is:
- Marketing, promotional, newsletters, product announcements, sales pitches
- Automated notifications that don't need attention (social media alerts, service notifications)
- Actual spam or junk
- Subscriptions or mailing lists
- Mass-sent emails not personally addressed to Rob
- Anything Rob doesn't need to see or act on

Mark as NOT spam (false) if the email is:
- From a real person who expects a response
- A customer inquiry, order, or business communication
- From a supplier about deliveries, pricing, or production
- Financial (bank, invoices, payments)
- Personal (family, friends)
- From an employee or contractor
- A reply to something Rob sent

When in doubt, mark as NOT spam. Better to let a real email through than miss it.`,
      messages: [{
        role: 'user',
        content: `Classify these emails:\n\n${emailList}`,
      }],
    });

    const responseText = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    const classifications = parseEmailScanResponse(responseText);

    // Collect spam email IDs grouped by account
    const spamByAccount = new Map<string, string[]>();
    const notSpam: typeof untagged = [];

    for (const cls of classifications) {
      const email = untagged[cls.index - 1];
      if (!email) continue;

      if (cls.spam) {
        if (!spamByAccount.has(email.account)) {
          spamByAccount.set(email.account, []);
        }
        spamByAccount.get(email.account)!.push(email.id);
      } else {
        notSpam.push(email);
      }
    }

    // RFQ reply intake (spec §12.3): a vendor's answer to one of our RFQs
    // must not sit in the inbox for up to a day waiting on the 5 AM triage —
    // run the same matcher/intake the briefing uses over every not-spam
    // message here too. Idempotent per inbound message id (`rfq_replies`),
    // so a reply this scan already filed is a no-op for the next one, and
    // for the 5 AM triage if it sees the same message again.
    const rfqScanSummary = await runRfqScan(notSpam);
    if (rfqScanSummary) {
      console.log(
        `RFQ scan: ${rfqScanSummary.matched} matched, ${rfqScanSummary.filed} quote(s) filed, `
        + `${rfqScanSummary.noted} carded, ${rfqScanSummary.skipped} already processed.`,
      );
      if (rfqScanSummary.errors.length > 0) console.error('RFQ scan errors:', rfqScanSummary.errors.join('; '));
    }

    // Bulk-tag spam emails
    const { getGraphToken } = await import('./auth/graph.js');
    const token = await getGraphToken();
    let spamCount = 0;

    for (const [account, ids] of spamByAccount) {
      for (let i = 0; i < ids.length; i += 20) {
        const batch = ids.slice(i, i + 20);
        const requests = batch.map((id, idx) => ({
          id: String(idx + 1),
          method: 'PATCH',
          url: `/users/${account}/messages/${id}`,
          headers: { 'Content-Type': 'application/json' },
          body: { categories: ['spam'] },
        }));

        const res = await fetch('https://graph.microsoft.com/v1.0/$batch', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ requests }),
        });

        if (res.ok) {
          const data = (await res.json()) as { responses: { status: number }[] };
          spamCount += data.responses.filter((r) => r.status >= 200 && r.status < 300).length;
        }
      }
    }

    console.log(`Email scan complete: ${spamCount} tagged as spam, ${notSpam.length} not spam.`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Email scan failed:', msg);
  }
}

async function handleEveningSummary(): Promise<void> {
  const users = getActiveUsers(db);
  const today = getChicagoDate();
  const now = new Date();

  for (const user of users) {
    // Per-user gating: admin EOD at 7 PM CT, members at 2:30 PM CT (default).
    if (!shouldUserEodNow(db, user.id, now)) continue;

    try {
      const logs = getTimeLogsForDate(db, user.id, today);

      let summary: string;
      if (logs.length === 0) {
        summary = 'No time entries logged today.';
      } else {
        const logList = logs
          .map((l) => `${l.hour}:00 — ${l.activity}${l.category !== 'untracked' ? ` (${l.category})` : ''}`)
          .join('\n');
        summary = `Time Log:\n${logList}\n\nTotal tracked hours: ${logs.length}`;
      }

      let preview: string;
      try {
        preview = await getTomorrowEventsPreview(db, user.id, now);
      } catch (err) {
        console.error(`Tomorrow preview failed for ${user.name}: ${(err as Error).message}`);
        preview = 'No events scheduled for tomorrow.';
      }

      const fullMsg = `End of Day Summary\n\n${summary}\n\n${preview}\n\nHow was your day? Anything you want to reflect on?`;
      await sendMessageToUser(user.id, fullMsg, false);
      insertConversationMessage(db, user.id, today, 'secretary', fullMsg);
      awaitingReflectionFromUser.add(user.id);
    } catch (err) {
      console.error(`Evening summary failed for ${user.name}: ${(err as Error).message}`);
    }
  }

  // Reflection moved to morning handler — runs next day with full conversation data
}

async function handleEmailCleanup(userId: string): Promise<string> {
  console.log('Running email cleanup scan...');

  const accounts = getUserEmailAccounts(db, userId);
  const emailResults = await Promise.all(
    accounts.map((a) => fetchRecentEmails(a.email_address, 72, 50).catch(() => [])),
  );

  const allEmails = emailResults.flat();
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
    output_config: { format: CLEANUP_OUTPUT_FORMAT },
    system: CLEANUP_SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: `Which of these emails are junk, newsletters, promotional, or transactional that can be safely archived?\n\n${emailList}`,
    }],
  });

  const responseText = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');

  const indices = parseCleanupResponse(responseText);
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

async function handleIncomingMessage(user: User, text: string): Promise<string> {
  const hour = getChicagoHour();
  const today = getChicagoDate();
  const lowerText = text.toLowerCase().trim();

  // Store user's message
  insertConversationMessage(db, user.id, today, 'rob', text);

  // End-of-day reflection capture: if the EOD summary just went out and this is
  // the next user message, save the text as a journal entry and acknowledge.
  // Skip if the reply is itself a command.
  if (
    awaitingReflectionFromUser.has(user.id) &&
    text.trim().length > 0 &&
    !text.startsWith('/')
  ) {
    awaitingReflectionFromUser.delete(user.id);
    try {
      const { writeRobJournal, readRobJournal } = await import('./journal/files.js');
      const existing = readRobJournal(today);
      const timestamp = new Date().toLocaleTimeString('en-US', {
        timeZone: TIMEZONE,
        hour: 'numeric',
        minute: '2-digit',
      });
      const entry = `[${timestamp}] [EOD reflection] ${text.trim()}`;
      const newContent = existing
        ? `${existing}\n\n${entry}`
        : `# ${user.name}'s Journal — ${today}\n\n${entry}`;
      writeRobJournal(today, newContent);
      const ack = 'Saved to today\'s journal. Rest up.';
      insertConversationMessage(db, user.id, today, 'secretary', ack);
      return ack;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('Failed to save EOD reflection:', msg);
      // Fall through to normal handling if journal write fails.
    }
  }

  // Dev request commands — available to all users
  if (lowerText.startsWith('/request ')) {
    const description = text.slice(9).trim();
    if (!description) {
      return 'Usage: /request <description of what you need>';
    }
    // Try to extract project name if mentioned
    const projectMatch = description.match(/^(\S+):\s*(.*)/);
    const project = projectMatch ? projectMatch[1] : undefined;
    const desc = projectMatch ? projectMatch[2]! : description;
    const id = insertDevRequest(db, { user_id: user.id, project, description: desc });
    insertConversationMessage(db, user.id, today, 'secretary', `Request #${id} submitted. Robert will review it.`);
    // Notify Robert
    await sendMessageToUser(ROBERT_ID, `New dev request #${id} from ${user.name}: ${desc}`).catch(() => {});
    return `Request #${id} submitted. Robert will review it.`;
  }

  if (lowerText === '/myrequests') {
    const reqs = getDevRequestsByUser(db, user.id);
    if (reqs.length === 0) return 'No requests submitted yet.';
    const list = reqs.slice(0, 10).map((r) =>
      `#${r.id} [${r.status}] ${r.project ? `(${r.project}) ` : ''}${r.description.slice(0, 60)}`
    ).join('\n');
    return `Your requests:\n${list}`;
  }

  // South Loop Lions schedule + any active schedule-change alerts.
  if (lowerText === '/lions' && user.role === 'admin') {
    const snapshot = getLatestSnapshot(db);
    const reply = formatScheduleForTelegram(
      snapshot?.games ?? [],
      getActiveAlerts(db),
      snapshot?.taken_at ?? null,
      lionsConfig(process.env).baseUrl,
    );
    insertConversationMessage(db, user.id, today, 'secretary', reply);
    return reply;
  }

  // Admin-only: /review, /approve, /reject
  if (lowerText === '/review' && user.role === 'admin') {
    const pending = getPendingDevRequests(db);
    if (pending.length === 0) return 'No pending dev requests.';
    const list = pending.map((r) => {
      const submitter = getUserById(db, r.user_id);
      return `#${r.id} from ${submitter?.name ?? r.user_id}${r.project ? ` (${r.project})` : ''}: ${r.description}`;
    }).join('\n');
    return `Pending requests:\n${list}\n\nUse /approve <id> [refined description] or /reject <id> <reason>`;
  }

  if (lowerText.startsWith('/approve ') && user.role === 'admin') {
    const parts = text.slice(9).trim().split(/\s+/);
    const id = parseInt(parts[0]!, 10);
    if (isNaN(id)) return 'Usage: /approve <id> [refined description]';
    const refined = parts.slice(1).join(' ') || undefined;
    approveDevRequest(db, id, user.id, refined);
    const req = getDevRequestById(db, id);
    // Notify the requester
    if (req) {
      await sendMessageToUser(req.user_id, `Your request #${id} was approved!${refined ? ` Refined: ${refined}` : ''}`).catch(() => {});
    }
    // McSecretary does not write to GitHub or queue build work (Robert, 2026-09-10).
    // Approval records the decision here; the build itself goes to the Foreman session.
    return `Request #${id} approved.${refined ? ` Refined: ${refined}` : ''}\nRecorded here only — send it to the Foreman session (Claude Code) to get it built.`;
  }

  if (lowerText.startsWith('/reject ') && user.role === 'admin') {
    const parts = text.slice(8).trim().split(/\s+/);
    const id = parseInt(parts[0]!, 10);
    if (isNaN(id)) return 'Usage: /reject <id> <reason>';
    const reason = parts.slice(1).join(' ') || 'No reason given';
    rejectDevRequest(db, id, user.id, reason);
    const req = getDevRequestById(db, id);
    if (req) {
      await sendMessageToUser(req.user_id, `Your request #${id} was not approved: ${reason}`).catch(() => {});
    }
    return `Request #${id} rejected: ${reason}`;
  }

  // Admin-only: /invite <user-email> — generate a 7-day invite code
  if (lowerText.startsWith('/invite ') && user.role === 'admin') {
    const email = text.slice(8).trim().toLowerCase();
    if (!email || !email.includes('@')) {
      return 'Usage: /invite <user-email>';
    }
    const targetUser = getUserByEmail(db, email);
    if (!targetUser) {
      return `No user found with email: ${email}`;
    }
    const code = createInvite(db, targetUser.id);
    return `Invite code for ${targetUser.name} (${email}):\n\n\`${code}\`\n\nExpires in 7 days. They send /start ${code} to the bot.`;
  }

  // Admin-only: /onboard-all-pending — bulk-mint invites + email them for
  // everyone listed in pending_invites.json at the repo root. Entries with
  // a non-empty onboarded_at are skipped. See src/onboarding/pending-invites.ts.
  if (lowerText === '/onboard-all-pending' && user.role === 'admin') {
    try {
      const { processPendingInvites, formatOnboardingSummary, defaultManifestPath } =
        await import('./onboarding/pending-invites.js');
      const result = await processPendingInvites(db, {
        manifestPath: defaultManifestPath(),
      });
      return formatOnboardingSummary(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Bulk onboarding failed: ${msg}`;
    }
  }

  // Admin-only: /onboarding-status [--pending-only] — list pending vs
  // onboarded entries from pending_invites.json. Capped at 20 per section
  // (older entries truncated). `--pending-only` suppresses the Onboarded
  // section for a tighter "who's still waiting" view.
  if (user.role === 'admin') {
    const { parseOnboardingStatusCommand } = await import('./onboarding/status.js');
    const parsedStatus = parseOnboardingStatusCommand(text);
    if (parsedStatus.matched) {
      try {
        const { readAndRenderOnboardingStatus, defaultStatusManifestPath } = await import(
          './onboarding/status.js'
        );
        return readAndRenderOnboardingStatus(defaultStatusManifestPath(), {
          pendingOnly: parsedStatus.pendingOnly,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Onboarding status failed: ${msg}`;
      }
    }
  }

  // Admin-only: /briefing-preview [--user=<name>] [--sections=<csv>] — render
  // tomorrow's 5 AM briefing right now for review. Re-uses the exact
  // `runTriage` render path the morning handler calls; no duplicate rendering
  // logic. When `--user=<name>` is present the preview is generated as if for
  // that user (case-insensitive first-name match). When `--sections=<csv>` is
  // present only those sections render (invalid section names return an error
  // listing the valid set). Admin-gated because non-admins already have
  // `/briefing` which renders their own briefing on demand.
  if (user.role === 'admin') {
    const { parseBriefingPreviewCommand, findUserByFirstName } = await import(
      './briefing/preview-command.js'
    );
    const parsedPreview = parseBriefingPreviewCommand(text);
    if (parsedPreview.matched) {
      try {
        let targetUser: User = user;
        if (parsedPreview.targetName) {
          const resolved = findUserByFirstName(db, parsedPreview.targetName);
          if (!resolved) {
            return `No user named "${parsedPreview.targetName}" found.`;
          }
          targetUser = resolved;
        }
        let sectionsFilter: string[] | undefined;
        if (parsedPreview.sectionsRaw !== undefined) {
          const { parseSectionList, formatValidSectionsList } = await import(
            './briefing/sections.js'
          );
          const { valid, invalid } = parseSectionList(parsedPreview.sectionsRaw);
          if (invalid.length > 0) {
            return `Invalid section name(s): ${invalid.join(', ')}. Valid sections: ${formatValidSectionsList()}.`;
          }
          if (valid.length === 0) {
            return `No valid sections provided. Valid sections: ${formatValidSectionsList()}.`;
          }
          sectionsFilter = valid;
        }
        // Briefing UX Polish 7 (2026-04-29): cache identical previews for
        // 5 min keyed on (user, sortedSections). Cache hit short-circuits the
        // costly `runTriage` round-trip. Failures inside the cache layer are
        // contained so a cache bug never blocks the preview.
        const previewCache = await getBriefingPreviewCache();
        let briefing: string;
        const cached = previewCache.get(targetUser.id, sectionsFilter);
        if (cached !== undefined) {
          briefing = cached;
        } else {
          briefing = await runTriage(
            db,
            targetUser.id,
            sectionsFilter ? { sections: sectionsFilter } : undefined,
          );
          try {
            previewCache.set(targetUser.id, sectionsFilter, briefing);
          } catch {
            /* never let a cache-write failure surface */
          }
        }
        insertConversationMessage(
          db,
          user.id,
          today,
          'secretary',
          `[Briefing Preview — target=${targetUser.name}]\n${briefing}`,
        );
        const header =
          targetUser.id === user.id
            ? '[Preview — what tomorrow\'s 5 AM briefing will look like]\n\n'
            : `[Preview — what tomorrow's 5 AM briefing will look like for ${targetUser.name}]\n\n`;
        return `${header}${briefing}`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const errorMsg = `Briefing preview failed: ${msg}`;
        insertConversationMessage(db, user.id, today, 'secretary', errorMsg);
        return errorMsg;
      }
    }
  }

  // Admin-only: /briefing-sections --user=<name> (--set=<csv> | --reset | --list | --diff | --clone-from=<src>)
  // OR /briefing-sections --list
  // OR /briefing-sections --set-all=<csv> --apply-to=all
  //
  // Read, write, clear, diff, clone, or bulk-set the per-user
  // `briefing_sections_json` preference. When set, that user's daily 5 AM
  // briefing renders ONLY those sections in the stored array order. When
  // cleared (NULL), they revert to the default all-sections behavior.
  //
  // Forms:
  //   --list                     → canonical catalog (no --user)
  //   --user --list              → that user's stored pref
  //   --user --set=<csv>         → write
  //   --user --reset             → clear (NULL)
  //   --user --diff              → user's pref vs full briefing (missing sections + order)
  //   --user=<target> --clone-from=<src> → copy src's pref onto target
  //   --set-all=<csv> --apply-to=all → bulk-write to every onboarded user
  if (user.role === 'admin') {
    const { parseBriefingSectionsCommand } = await import('./briefing/sections-command.js');
    const parsedSections = parseBriefingSectionsCommand(text);
    if (parsedSections.matched) {
      try {
        const { findUserByFirstName } = await import('./briefing/preview-command.js');
        const {
          parseSectionList,
          formatValidSectionsList,
          formatSectionListWithDescriptions,
          VALID_BRIEFING_SECTIONS,
        } = await import('./briefing/sections.js');
        const {
          setUserBriefingSections,
          getUserBriefingSections,
          getActiveUsers,
          insertBriefingSectionsAudit,
          getBriefingSectionsAuditForUserSince,
          getBriefingSectionsAuditById,
          pruneBriefingSectionsAuditOlderThan,
        } = await import('./db/user-queries.js');

        // Audit-log retention — auto-prune rows older than the configured
        // window before each insert. Default 90d, clamp [1, 3650]. Best-effort:
        // any failure is logged and swallowed (never blocks the action).
        const resolveRetentionDays = (): number => {
          const raw = process.env.BRIEFING_AUDIT_RETENTION_DAYS;
          const fallback = 90;
          if (!raw) return fallback;
          const parsed = Number.parseInt(raw, 10);
          if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
          if (parsed < 1) return 1;
          if (parsed > 3650) return 3650;
          return parsed;
        };

        // Helper — best-effort audit write; never propagates errors. Also
        // auto-prunes rows older than the retention window on every insert.
        const writeAudit = (input: {
          user_name: string;
          action: 'set' | 'reset' | 'set-all' | 'clone-from' | 'revert';
          source_user?: string | null;
          sections_json?: string | null;
        }): void => {
          try {
            insertBriefingSectionsAudit(db, input);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`briefing_sections_audit write failed: ${msg}`);
          }
          try {
            const days = resolveRetentionDays();
            const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
            pruneBriefingSectionsAuditOlderThan(db, cutoff);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`briefing_sections_audit prune failed: ${msg}`);
          }
        };

        // --set-all path: bulk-set every onboarded user. No --user.
        if (parsedSections.setAllRaw !== undefined) {
          const { valid, invalid } = parseSectionList(parsedSections.setAllRaw);
          if (invalid.length > 0) {
            return `Invalid section name(s): ${invalid.join(', ')}. Valid sections: ${formatValidSectionsList()}.`;
          }
          if (valid.length === 0) {
            return `No valid sections provided. Valid sections: ${formatValidSectionsList()}.`;
          }
          const onboarded = getActiveUsers(db);
          for (const u of onboarded) {
            setUserBriefingSections(db, u.id, valid);
          }
          // Audit one row per affected user so the digest reports the full set.
          const sectionsJson = JSON.stringify(valid);
          for (const u of onboarded) {
            writeAudit({
              user_name: u.name,
              action: 'set-all',
              sections_json: sectionsJson,
            });
          }
          const names = onboarded.map((u) => u.name);
          const shown = names.slice(0, 20);
          const extra = names.length - shown.length;
          const tail = extra > 0 ? `, ...and ${extra} more` : '';
          return `Updated ${onboarded.length} users: ${shown.join(', ')}${tail}. Sections: ${valid.join(', ')}.`;
        }

        // --clone-from path: copy <src>'s pref onto <target>. Requires --user=<target>.
        if (parsedSections.cloneFrom !== undefined) {
          const targetName = parsedSections.targetName as string;
          const srcName = parsedSections.cloneFrom;
          // Self-clone is a no-op error — friendly message.
          if (targetName.trim().toLowerCase() === srcName.trim().toLowerCase()) {
            return `Cannot clone-from self.`;
          }
          const src = findUserByFirstName(db, srcName);
          if (!src) {
            return `User '${srcName}' not found.`;
          }
          const target = findUserByFirstName(db, targetName);
          if (!target) {
            return `User '${targetName}' not found.`;
          }
          const srcStored = getUserBriefingSections(db, src.id);
          if (!srcStored || srcStored.length === 0) {
            // Source has NULL prefs (default full briefing) — write NULL on target.
            setUserBriefingSections(db, target.id, null);
            writeAudit({
              user_name: target.name,
              action: 'clone-from',
              source_user: src.name,
              sections_json: null,
            });
            return `Cloned briefing prefs from '${src.name}' to '${target.name}'. Sections: (default: full briefing)`;
          }
          // Filter to known sections so a stale src pref containing a removed
          // section name can't be propagated forward.
          const valid = srcStored.filter((s): s is string =>
            (VALID_BRIEFING_SECTIONS as readonly string[]).includes(s),
          );
          if (valid.length === 0) {
            setUserBriefingSections(db, target.id, null);
            writeAudit({
              user_name: target.name,
              action: 'clone-from',
              source_user: src.name,
              sections_json: null,
            });
            return `Cloned briefing prefs from '${src.name}' to '${target.name}'. Sections: (default: full briefing)`;
          }
          setUserBriefingSections(db, target.id, valid);
          writeAudit({
            user_name: target.name,
            action: 'clone-from',
            source_user: src.name,
            sections_json: JSON.stringify(valid),
          });
          return `Cloned briefing prefs from '${src.name}' to '${target.name}'. Sections: ${valid.join(', ')}`;
        }

        // --list path: read-only. Bare → catalog. With --user → that user's pref.
        if (parsedSections.list) {
          if (!parsedSections.targetName) {
            return `Valid briefing sections:\n${formatSectionListWithDescriptions()}`;
          }
          const target = findUserByFirstName(db, parsedSections.targetName);
          if (!target) {
            return `No user named "${parsedSections.targetName}" found.`;
          }
          const stored = getUserBriefingSections(db, target.id);
          if (!stored || stored.length === 0) {
            return `${target.name} briefing-sections preference: (default: full briefing)`;
          }
          return `${target.name} briefing-sections preference: ${stored.join(', ')}`;
        }

        // --diff path: read-only. Requires --user. Shows user's pref vs full briefing
        // (current sections, missing sections, render order).
        if (parsedSections.diff) {
          const targetName = parsedSections.targetName as string;
          const target = findUserByFirstName(db, targetName);
          if (!target) {
            return `User '${targetName}' not found. Use /onboarding-status for the list.`;
          }
          const stored = getUserBriefingSections(db, target.id);
          if (!stored || stored.length === 0) {
            return [
              `User: ${target.name}`,
              `Current: (default: full briefing)`,
              `Missing: (none)`,
            ].join('\n');
          }
          // Filter the stored array to only known sections (defense-in-depth so
          // a stale pref containing a removed section name doesn't poison output).
          const storedKnown = stored.filter((s): s is string =>
            (VALID_BRIEFING_SECTIONS as readonly string[]).includes(s),
          );
          const missing = (VALID_BRIEFING_SECTIONS as readonly string[]).filter(
            (s) => !storedKnown.includes(s),
          );
          return [
            `User: ${target.name}`,
            `Current: ${storedKnown.join(', ')}`,
            `Missing: ${missing.length === 0 ? '(none)' : missing.join(', ')}`,
            `Order: [${storedKnown.join(', ')}]`,
          ].join('\n');
        }

        // --history path: read-only. Requires --user. Optional --days=N
        // (default 7, clamp [1, 90] — audit rows older than 90d are pruned).
        if (parsedSections.history) {
          const targetName = parsedSections.targetName as string;
          const target = findUserByFirstName(db, targetName);
          if (!target) {
            return `User '${targetName}' not found.`;
          }
          const requested = parsedSections.historyDays ?? 7;
          const clamped = requested < 1 ? 1 : requested > 90 ? 90 : requested;
          const cutoff = new Date(Date.now() - clamped * 24 * 60 * 60 * 1000).toISOString();
          const rows = getBriefingSectionsAuditForUserSince(db, target.name, cutoff);
          // --json modifier (Polish 6, 2026-04-28): emit programmatic JSON
          // array (newest-first) instead of human-readable lines. Empty
          // history → `[]`. `sections` field is the parsed raw array (NOT
          // stale-filtered) so programmatic consumers see exactly what was
          // stored. NULL sections_json → `sections: null`.
          if (parsedSections.json) {
            const jsonRows = rows.map((row) => {
              let sections: string[] | null = null;
              if (row.sections_json !== null) {
                try {
                  const parsed = JSON.parse(row.sections_json);
                  if (Array.isArray(parsed)) {
                    sections = parsed.filter((x): x is string => typeof x === 'string');
                  }
                } catch {
                  sections = null;
                }
              }
              return {
                id: row.id,
                ts: row.ts,
                action: row.action,
                source_user: row.source_user,
                sections,
                actor: row.actor,
              };
            });
            return JSON.stringify(jsonRows);
          }
          if (rows.length === 0) {
            return `No audit history for '${target.name}' in last ${clamped} day(s).`;
          }
          const lines = rows.map((row) => {
            const dt = new Date(row.ts);
            const yyyy = dt.getUTCFullYear();
            const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
            const dd = String(dt.getUTCDate()).padStart(2, '0');
            const hh = String(dt.getUTCHours()).padStart(2, '0');
            const mi = String(dt.getUTCMinutes()).padStart(2, '0');
            const stamp = `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
            const fromPart = row.source_user ? ` from ${row.source_user}` : '';
            let sectionsLabel: string;
            if (row.sections_json === null) {
              sectionsLabel = '(default)';
            } else {
              try {
                const parsed = JSON.parse(row.sections_json);
                if (Array.isArray(parsed) && parsed.length > 0) {
                  const strs = parsed.filter((x): x is string => typeof x === 'string');
                  sectionsLabel = strs.length === 0 ? '(default)' : strs.join(',');
                } else {
                  sectionsLabel = '(default)';
                }
              } catch {
                sectionsLabel = '(default)';
              }
            }
            return `${stamp} ${row.action}${fromPart} sections=${sectionsLabel}`;
          });
          return lines.join('\n');
        }

        // --revert path: undo the most recent action by writing the prior
        // sections_json from the audit log (the 2nd-most-recent row for this
        // user). The most-recent row is the action being reverted. Writes
        // itself as a new audit row with action=revert.
        //
        // Polish 5 (2026-04-27) added `--to=<audit-id>` for targeted reverts:
        // revert to a specific historical audit row instead of just the
        // previous one. The targeted row's sections_json is applied back to
        // the user; the new audit row records `source_user='audit:<id>'` so
        // the trail stays inspectable.
        if (parsedSections.revert) {
          const targetName = parsedSections.targetName as string;
          const target = findUserByFirstName(db, targetName);
          if (!target) {
            return `User '${targetName}' not found.`;
          }

          // Helper: extract a normalized sections array from a prior audit
          // row, filtering to known section names so stale rows can't
          // propagate forward. Returns null when the row stored NULL or
          // an empty/invalid array.
          const extractPriorSections = (sectionsJson: string | null): string[] | null => {
            if (sectionsJson === null) return null;
            try {
              const parsed = JSON.parse(sectionsJson);
              if (Array.isArray(parsed)) {
                const strs = parsed.filter((x): x is string => typeof x === 'string');
                const valid = strs.filter((s) =>
                  (VALID_BRIEFING_SECTIONS as readonly string[]).includes(s),
                );
                return valid.length === 0 ? null : valid;
              }
            } catch {
              /* fall through */
            }
            return null;
          };

          const labelFor = (priorSections: string[] | null): string =>
            priorSections === null || priorSections.length === 0
              ? '(default: full briefing)'
              : priorSections.join(', ');

          // Best-effort revert-spike alert. Never blocks the reply. Shared
          // between the bare --revert and --to=<id> branches so any revert
          // (regardless of shape) increments the daily counter.
          const fireRevertAlertIfWarranted = async (): Promise<void> => {
            try {
              const { maybeFireRevertAlert } = await import('./briefing/revert-alert.js');
              await maybeFireRevertAlert(db, target.name, {
                sendMessage: async (text: string) => {
                  await sendMessage(text, false).catch(() => {});
                },
              });
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              console.error(`maybeFireRevertAlert failed: ${msg}`);
            }
          };

          // --to=<id> branch: validate and revert to a specific audit row.
          if (parsedSections.revertTo !== undefined) {
            const auditId = parsedSections.revertTo;
            const targetRow = getBriefingSectionsAuditById(db, auditId);
            if (!targetRow) {
              return `Audit id ${auditId} not found.`;
            }
            if (targetRow.user_name.trim().toLowerCase() !== target.name.trim().toLowerCase()) {
              return `Audit id ${auditId} belongs to '${targetRow.user_name}', not '${target.name}'.`;
            }
            // Confirm it's not the current (most-recent) row — that would be a no-op.
            const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
            const rows = getBriefingSectionsAuditForUserSince(db, target.name, cutoff);
            if (rows.length === 0) {
              // Pruned out of window — treat as not-found for revert purposes.
              return `Audit id ${auditId} is outside the revert window for '${target.name}'.`;
            }
            const mostRecent = rows[0];
            if (mostRecent && mostRecent.id === auditId) {
              return `Audit id ${auditId} is the current state for '${target.name}'; nothing to revert.`;
            }
            const priorSections = extractPriorSections(targetRow.sections_json);
            setUserBriefingSections(db, target.id, priorSections);
            writeAudit({
              user_name: target.name,
              action: 'revert',
              source_user: `audit:${auditId}`,
              sections_json: priorSections === null ? null : JSON.stringify(priorSections),
            });
            await fireRevertAlertIfWarranted();
            return `Reverted briefing prefs for '${target.name}' to audit ${auditId}: ${labelFor(priorSections)}.`;
          }

          // Bare --revert: undo most-recent action (Polish 4 behavior).
          const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
          const rows = getBriefingSectionsAuditForUserSince(db, target.name, cutoff);
          if (rows.length < 2) {
            return `No prior briefing-sections action to revert for '${target.name}'.`;
          }
          // rows is newest-first; the second one is the prior state.
          const prior = rows[1];
          if (!prior) {
            return `No prior briefing-sections action to revert for '${target.name}'.`;
          }
          const priorSections = extractPriorSections(prior.sections_json);
          setUserBriefingSections(db, target.id, priorSections);
          writeAudit({
            user_name: target.name,
            action: 'revert',
            sections_json: priorSections === null ? null : JSON.stringify(priorSections),
          });
          await fireRevertAlertIfWarranted();
          return `Reverted briefing prefs for '${target.name}' to ${labelFor(priorSections)}.`;
        }

        // --set / --reset path: requires --user (parser already enforces this).
        const targetName = parsedSections.targetName as string;
        const target = findUserByFirstName(db, targetName);
        if (!target) {
          return `No user named "${targetName}" found.`;
        }
        if (parsedSections.reset) {
          setUserBriefingSections(db, target.id, null);
          writeAudit({
            user_name: target.name,
            action: 'reset',
            sections_json: null,
          });
          return `Cleared briefing-sections preference for ${target.name}. They will receive the full briefing.`;
        }
        const { valid, invalid } = parseSectionList(parsedSections.setRaw ?? '');
        if (invalid.length > 0) {
          return `Invalid section name(s): ${invalid.join(', ')}. Valid sections: ${formatValidSectionsList()}.`;
        }
        if (valid.length === 0) {
          return `No valid sections provided. Valid sections: ${formatValidSectionsList()}.`;
        }
        setUserBriefingSections(db, target.id, valid);
        writeAudit({
          user_name: target.name,
          action: 'set',
          sections_json: JSON.stringify(valid),
        });
        return `Set briefing sections for ${target.name}: ${valid.join(', ')}.`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Briefing-sections update failed: ${msg}`;
      }
    }
  }

  // Run the RFQ reply intake immediately instead of waiting on the next
  // 30-minute Email Scan or the 5 AM triage — admin only, like other
  // on-demand ops commands (journal, dev requests).
  if ((lowerText === '/scan rfq' || lowerText === 'scan rfq') && user.role === 'admin') {
    try {
      const accounts = getUserEmailAccounts(db, user.id);
      const emailResults = await Promise.all(
        accounts.map((a) => fetchRecentEmails(a.email_address, 72, 50, true).catch(() => [])),
      );
      const summary = await runRfqScan(emailResults.flat());
      const response = summary
        ? `RFQ scan: ${summary.matched} matched, ${summary.filed} quote(s) filed, `
          + `${summary.noted} carded, ${summary.skipped} already processed.`
          + (summary.errors.length > 0 ? `\nErrors: ${summary.errors.join('; ')}` : '')
        : 'RFQ scan: intake handler not registered yet.';
      insertConversationMessage(db, user.id, today, 'secretary', response);
      return response;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const errorMsg = `RFQ scan failed: ${msg}`;
      insertConversationMessage(db, user.id, today, 'secretary', errorMsg);
      return errorMsg;
    }
  }

  // Direct commands
  if (lowerText === '/briefing' || lowerText === 'briefing') {
    try {
      const briefing = await runTriage(db, user.id);
      insertConversationMessage(db, user.id, today, 'secretary', `[Briefing]\n${briefing}`);
      return briefing;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const errorMsg = `Briefing failed: ${msg}`;
      insertConversationMessage(db, user.id, today, 'secretary', errorMsg);
      return errorMsg;
    }
  }

  if (lowerText === '/status' || lowerText === 'status') {
    const logs = getTimeLogsForDate(db, user.id, today);
    const response = logs.length === 0
      ? 'No time entries logged today.'
      : logs.map((l) => `${l.hour}:00 — ${l.activity}`).join('\n');
    insertConversationMessage(db, user.id, today, 'secretary', response);
    return response;
  }

  if (lowerText.startsWith('/log ')) {
    const activity = text.slice(5).trim();
    insertTimeLog(db, user.id, { date: today, hour: hour - 1, activity });
    const response = `Logged for ${hour - 1}:00: ${activity}`;
    insertConversationMessage(db, user.id, today, 'secretary', response);
    return response;
  }

  // Journal entry: "journal: [thoughts]" — admin only for now
  if ((lowerText.startsWith('journal:') || lowerText.startsWith('journal ')) && user.role === 'admin') {
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
      insertConversationMessage(db, user.id, today, 'secretary', response);
      return response;
    }
  }

  // Email cleanup commands
  if (lowerText === 'clean up email' || lowerText === 'clean email' || lowerText === 'cleanup email' || lowerText.includes('clean up my email') || lowerText.includes('archive junk')) {
    try {
      const response = await handleEmailCleanup(user.id);
      insertConversationMessage(db, user.id, today, 'secretary', response);
      return response;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const errorMsg = `Email cleanup failed: ${msg}`;
      insertConversationMessage(db, user.id, today, 'secretary', errorMsg);
      return errorMsg;
    }
  }

  // Archive approval
  if ((lowerText === 'archive' || lowerText === 'yes' || lowerText.startsWith('keep ')) && pendingArchiveBatch.length > 0) {
    try {
      const response = await executeArchive(text);
      insertConversationMessage(db, user.id, today, 'secretary', response);
      return response;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const errorMsg = `Archive failed: ${msg}`;
      insertConversationMessage(db, user.id, today, 'secretary', errorMsg);
      return errorMsg;
    }
  }

  // Check-in response
  if (awaitingCheckInResponse && text.length < 300 && !text.includes('?')) {
    awaitingCheckInResponse = false;
    insertTimeLog(db, user.id, { date: today, hour: hour - 1, activity: text.trim() });
    const response = `Logged for ${hour - 1}:00: ${text.trim()}`;
    insertConversationMessage(db, user.id, today, 'secretary', response);
    return response;
  }

  // Full AI response with tools, conversation memory, email + task context
  try {
    console.log('Fetching email and task context...');

    const { getFormattedTaskLists } = await import('./tasks/todo.js');
    const { TOOL_DEFINITIONS, executeTool } = await import('./tools.js');

    // Fetch emails from user's accounts
    const accounts = getUserEmailAccounts(db, user.id);
    const emailPromises = accounts.map((a) =>
      fetchRecentEmails(a.email_address, 48, 25).catch(() => []),
    );
    const [emailResults, taskContext] = await Promise.all([
      Promise.all(emailPromises),
      getFormattedTaskLists().catch(() => 'Failed to load tasks.'),
    ]);

    const emailContext = formatEmailsForContext(emailResults.flat());
    const smsContext = getRecentSmsMessages(db, 24, 30);
    const dailyContext = buildDailyContext();
    const conversationHistory = buildConversationHistory(user.id, today);

    const prefs = getUserPreferences(db, user.id);
    const systemBlocks = buildChatSystemBlocks(
      {
        name: user.name,
        business_context: prefs?.business_context ?? null,
        accounts: accounts.map((a) => a.email_address),
        is_admin: user.role === 'admin',
      },
      { dailyContext, taskContext, smsContext, emailContext },
    );

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
    const MAX_ITERATIONS = 15;

    while (iterations < MAX_ITERATIONS) {
      iterations++;

      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        output_config: { effort: 'medium' },
        system: systemBlocks,
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
        const result = await executeTool(toolUse.name, toolUse.input as Record<string, any>, user.id);
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
    insertConversationMessage(db, user.id, today, 'secretary', finalText);

    return finalText;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const errorMsg = `Failed to process request: ${msg}`;
    insertConversationMessage(db, user.id, today, 'secretary', errorMsg);
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

  // Seed Robert if not already seeded
  seedRobert(db, config.telegram.chatId || '');

  // Seed team members (Olivier, Merab) so /invite can find them
  seedTeam(db);

  // Set DB reference for bot (multi-user message routing)
  setBotDb(db);

  ensureJournalDirs();

  anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

  // Initialize tools with DB reference
  const { setToolsDb } = await import('./tools.js');
  setToolsDb(db);

  // Start API server for Mac Mini agent
  initApi(db, config.api.secret);
  // Polish 8 (2026-04-30): expose live preview-cache to /admin endpoint.
  // Returns `undefined` until the cache is lazy-built on first /briefing-preview;
  // the endpoint reflects `disabled:true` in that pre-warm state.
  setBriefingPreviewCacheProvider(() => _briefingPreviewCache);
  const apiServer = startApiServer(config.api.port);

  const bot = await initBot();

  // grammY's default error handler STOPS the bot on any handler throw. Never let that happen.
  bot.catch((err) => { console.error('Telegram handler error', err.ctx?.update?.update_id, err.error); });

  const spine = buildSpine({
    db,
    transport: createTelegramTransport(bot.api),
    now: () => new Date().toISOString(),
    env: process.env,
    brandsDir: config.spine.brandsDir,
    agentKeys: parseAgentKeys(config.spine.agentKeys, { minLength: 16 }),
    fetch: (url, init) => fetch(url, init),
    getGraphToken,
  });
  setSpineHttpHandler(spine.handleHttp);

  const rfqBrandId = process.env.RFQ_BRAND_ID || 'dearborn-denim';

  // Chat → agent-graph router: the four graph tools file into the same spine.
  // No second approval flow and no second scheduler — a dispatch is a normal
  // pinned proposal and the work reaches the Mac mini as spine events.
  const { setGraphDeps } = await import('./graph/tools.js');
  setGraphDeps({
    db,
    brandId: process.env.GRAPH_BRAND_ID || rfqBrandId,
    brandsDir: config.spine.brandsDir,
    agentKeys: parseAgentKeys(config.spine.agentKeys, { minLength: 16 }),
    env: process.env,
    now: () => new Date().toISOString(),
    file: spine.file,
    handFetch: spine.handFetch,
  });

  // RFQ reply intake (spec §12.3): triage hands a recognised vendor reply here
  // instead of the Haiku classifier. The notes card and the
  // `vendor_quote_received` event go through the spine — no second approval
  // flow, no second scheduler.
  setRfqIntakeHandler(async (email, match) => processRfqReply(email, match, {
    db,
    now: () => new Date().toISOString(),
    brandId: rfqBrandId,
    extract: (e) => extractRfqOptions(e),
    saveAttachments: (e, rfqId) => saveRfqAttachments(e, rfqId, {
      fetch: (url, init) => fetch(url, init),
      getGraphToken,
      env: process.env,
    }),
    postVendorQuote: (body) => postVendorQuote(body, { fetch: (url, init) => fetch(url, init), env: process.env }),
    file: spine.file,
    emitEvent: (e) => { insertEvent(db, e, new Date().toISOString()); },
    sendAcknowledgement: (e, match) => sendRfqAcknowledgement(e, match, {
      db,
      fetch: (url, init) => fetch(url, init),
      getGraphToken,
      env: process.env,
      now: () => new Date().toISOString(),
    }),
  }));

  setRfqFilesHttpHandler(createRfqFilesRouter({ dir: rfqFilesDir(process.env) }));

  // Public team page + JSON, admin check/clear. Mounted before the legacy routes.
  setLionsHttpHandler(createLionsRouter({
    db,
    apiSecret: config.api.secret,
    runCheck: () => runLionsCheck({ db }),
    now: () => new Date().toISOString(),
  }));

  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    if (!data.startsWith('prop:')) return;
    const chatId = ctx.chat?.id.toString() ?? '';
    const by = getUserByTelegramChatId(db, chatId)?.id;
    if (!by) { await ctx.answerCallbackQuery({ text: 'Not registered' }).catch(() => {}); return; }
    let toast: string;
    try {
      toast = await spine.onCallback(data, chatId, by);
    } catch (err) {
      console.error('spine: callback failed', data, err);
      toast = 'Something went wrong — tap again.';
    }
    await ctx.answerCallbackQuery({ text: toast.slice(0, 200) }).catch(() => {});
  });

  bot.on('message:text', async (ctx) => {
    const chatId = ctx.chat.id.toString();
    const text = ctx.message.text;

    // Spine: an Edit reply or promote command for the inbox is consumed here, before anything else.
    const by = getUserByTelegramChatId(db, chatId)?.id ?? chatId;
    try {
      if (await spine.onText(chatId, text, by)) return;
    } catch (err) {
      console.error('spine: text intercept failed', err);
      await ctx.reply("Couldn't process that for the inbox — try again.").catch(() => {});
      return;
    }

    // Handle /start <invite_code> — account linking (no user lookup needed)
    if (text.startsWith('/start ') && text.trim().length > 7) {
      const code = text.slice(7).trim();
      if (!code) {
        await ctx.reply('Usage: /start <invite_code>');
        return;
      }
      const userId = consumeInvite(db, code);
      if (!userId) {
        await ctx.reply('Invalid or expired invite code.');
        return;
      }
      linkTelegramChat(db, userId, chatId);
      const linkedUser = getUserById(db, userId);
      // Best-effort: stamp started_at on the matching pending_invites.json entry
      // so the 48h reminder job knows this invitee completed onboarding.
      try {
        const { stampStartedAt, defaultStatusManifestPath } = await import(
          './onboarding/status.js'
        );
        if (linkedUser?.email) {
          stampStartedAt(defaultStatusManifestPath(), linkedUser.email);
        }
      } catch (err) {
        console.log(`Could not stamp started_at: ${(err as Error).message}`);
      }
      await ctx.reply(`Welcome, ${linkedUser?.name ?? 'friend'}! You're linked. Your briefings will arrive here.`);
      return;
    }

    // Look up user by chat_id
    const user = getUserByTelegramChatId(db, chatId);
    if (!user) {
      await ctx.reply('Not registered. Ask your admin for an invite code, then send: /start <code>');
      return;
    }

    console.log(`Message from ${user.name} (${user.id}): ${text.slice(0, 50)}...`);

    try {
      const response = await handleIncomingMessage(user, text);
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

  // Initialize scheduler from DB (with defaults for first run).
  // Check-In and Evening Summary fire on a union schedule (every 30 min, weekdays)
  // and per-user windows gate which users actually receive each tick. This lets
  // admin run 6 AM – 7 PM + 7 PM EOD while members run 6 AM – 2 PM + 2:30 PM EOD.
  initializeDefaultSchedule(db, [
    { name: 'Morning Briefing', schedule: '0 4 * * 1-5', handler: handleMorningBriefing, description: '4 AM weekdays — full email/calendar briefing' },
    { name: 'Hourly Check-In', schedule: '0,30 6-19 * * 1-5', handler: handleHourlyCheckIn, description: 'Every 30 min 6 AM–7 PM weekdays — per-user time tracking prompt' },
    { name: 'Evening Summary', schedule: '0,30 14-19 * * 1-5', handler: handleEveningSummary, description: '2 PM–7 PM weekdays — per-user day summary + tomorrow preview + reflection' },
    { name: 'Weekly Synthesis', schedule: '0 19 * * 0', handler: handleWeeklySynthesis, description: 'Sunday 7 PM — synthesize weekly learnings' },
    { name: 'Task Polling', schedule: '*/15 7-16 * * 1-5', handler: handleTaskPolling, description: 'Every 15 min during work hours — detect completed tasks' },
    { name: 'Email Scan', schedule: '*/30 * * * *', handler: handleEmailScan, description: 'Every 30 min, 24/7 — auto-tag new untagged emails as spam or not' },
    { name: 'Invite Reminders', schedule: '0 9 * * *', handler: handleInviteReminders, description: 'Daily 9 AM — resend invite to entries >48h old with no /start' },
    { name: 'Briefing Audit Digest', schedule: '0 7 * * *', handler: handleBriefingSectionsAuditDigest, description: 'Daily 7 AM CT — summarize last 24h of /briefing-sections preference changes' },
    { name: 'Spine Sweep', schedule: '0 5 * * *', handler: handleSpineSweep, description: 'Daily 5 AM CT — expire stale proposals, report undrained events and failed runs' },
    { name: 'Trust Monthly Summary', schedule: '0 7 1 * *', handler: handleTrustMonthlySummary, description: '1st of month 7 AM CT — per-agent trust ledger summary for promotion decisions' },
    { name: 'Lions Schedule Check', schedule: '0 6,12,18 * * *', handler: handleLionsCheck, description: '6 AM / noon / 6 PM CT — diff the CPS SCORE! sheet for South Loop Lions changes' },
    { name: 'Lions Schedule Check (Fri PM)', schedule: '0 20 * * 5', handler: handleLionsCheck, description: 'Friday 8 PM CT — last look before Saturday games' },
  ]);
  startSchedulerFromDb(db);

  console.log('Starting Telegram bot...');
  bot.start({
    onStart: () => {
      console.log('McSECREtary is running. Telegram bot active, scheduler started.');
      console.log('Scheduled: Morning briefing at 4 AM, check-ins 7 AM-3 PM, evening summary at 4 PM (weekdays, Central Time)');
    },
  });

  const shutdown = createShutdown({
    stopBot: async () => {
      stopAllJobs();
      await bot.stop();
    },
    stopServer: () =>
      new Promise<void>((resolve) => {
        apiServer.close(() => resolve());
        db.close();
      }),
    exit: (code) => process.exit(code),
    setTimer: (callback, ms) => setTimeout(callback, ms),
  });

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('McSECREtary crashed:', err);
  process.exit(1);
});
