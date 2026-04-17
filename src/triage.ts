import type Database from 'better-sqlite3';
import {
  insertProcessedEmail,
  getOrCreateSenderProfile,
  updateSenderProfile,
  insertAgentRun,
  completeAgentRun,
  insertAuditLog,
  getLastRunTimestamp,
} from './db/queries.js';
import {
  upsertCalendarEvent,
  insertPendingAction,
  getPendingActions,
  expirePendingActions,
  getWeeklySchedule,
} from './db/calendar-queries.js';
import { getUserEmailAccounts, getUserPreferences } from './db/user-queries.js';
import { fetchUnreadOutlookEmails } from './email/outlook.js';
import { classifyEmail } from './email/classifier.js';
import { determineAction, archiveOutlookEmail, markOutlookAsRead, categorizeOutlookEmail } from './email/actions.js';
import { generateBriefing } from './briefing/generator.js';
import type { UserBriefingContext } from './briefing/generator.js';
import { readRepoFile } from './empire/github.js';
import { formatPendingRequestsForBriefing } from './empire/request-sync.js';
import { getUserById } from './db/user-queries.js';
import { fetchOutlookCalendarEvents } from './calendar/outlook-calendar.js';
import { mergeEvents } from './calendar/merger.js';
import { findFreeSlots } from './calendar/free-slots.js';
import { detectConflicts } from './calendar/conflicts.js';
import { TIMEZONE, DEFAULT_WORK_START, DEFAULT_WORK_END } from './calendar/types.js';
import type { RawEmail, ClassifiedEmail } from './email/types.js';
import type { UnifiedEvent, CalendarBriefingData } from './calendar/types.js';

function getWorkBoundariesUtc(date: Date, workStart: string, workEnd: string): { dayStart: string; dayEnd: string } {
  const dateStr = date.toLocaleDateString('en-CA', { timeZone: TIMEZONE });
  const chicagoOffset = getChicagoOffsetMs(date);
  const startLocal = new Date(`${dateStr}T${workStart}:00`);
  const endLocal = new Date(`${dateStr}T${workEnd}:00`);

  return {
    dayStart: new Date(startLocal.getTime() - chicagoOffset).toISOString(),
    dayEnd: new Date(endLocal.getTime() - chicagoOffset).toISOString(),
  };
}

function getChicagoOffsetMs(date: Date): number {
  const utcDate = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
  const chicagoDate = new Date(date.toLocaleString('en-US', { timeZone: TIMEZONE }));
  return chicagoDate.getTime() - utcDate.getTime();
}

function getMondayOfWeek(date: Date): string {
  const d = new Date(date.toLocaleString('en-US', { timeZone: TIMEZONE }));
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(d.setDate(diff));
  return monday.toLocaleDateString('en-CA', { timeZone: TIMEZONE });
}

export async function runTriage(db: Database.Database, userId: string): Promise<string> {
  console.log(`McSECREtary — triage starting for user ${userId}...`);
  const startTime = Date.now();

  const { config } = await import('./config.js');

  const runId = insertAgentRun(db, userId, 'overnight');
  const lastRun = getLastRunTimestamp(db, userId, 'overnight');

  let totalProcessed = 0;
  let totalArchived = 0;
  let totalFlagged = 0;
  const allClassified: ClassifiedEmail[] = [];
  const errors: string[] = [];
  let calendarData: CalendarBriefingData | undefined;
  let briefing = '';

  try {
    console.log('Fetching emails and calendar...');

    // Fetch email accounts from DB for this user
    const emailAccounts = getUserEmailAccounts(db, userId);
    const emailAddresses = emailAccounts.map((a) => a.email_address);

    if (emailAddresses.length === 0) {
      console.log(`No email accounts configured for user ${userId}`);
    }

    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 2);
    const calStartDate = now.toISOString();
    const calEndDate = tomorrow.toISOString();

    // Fetch emails and calendar for all user's accounts in parallel
    const emailPromises = emailAddresses.map((email) =>
      fetchUnreadOutlookEmails(email, lastRun).catch((err) => {
        errors.push(`${email} fetch failed: ${err.message}`);
        return [] as RawEmail[];
      }),
    );
    const calPromises = emailAddresses.map((email) =>
      fetchOutlookCalendarEvents(email, calStartDate, calEndDate).catch((err) => {
        errors.push(`${email} calendar fetch failed: ${err.message}`);
        return [] as UnifiedEvent[];
      }),
    );

    const [emailResults, calResults] = await Promise.all([
      Promise.all(emailPromises),
      Promise.all(calPromises),
    ]);

    const allEmails = emailResults.flat();
    console.log(`Fetched ${allEmails.length} unread emails across ${emailAddresses.length} accounts`);

    // Process calendar
    console.log('Processing calendar...');
    const allCalEvents = calResults.flat();
    console.log(`Fetched ${allCalEvents.length} calendar events across ${emailAddresses.length} accounts`);

    for (const evt of allCalEvents) {
      upsertCalendarEvent(db, {
        id: evt.id,
        source: evt.source,
        calendar_email: evt.calendarEmail,
        title: evt.title,
        start_time: evt.startTime,
        end_time: evt.endTime,
        location: evt.location,
        is_all_day: evt.isAllDay ? 1 : 0,
        status: evt.status,
        attendees: JSON.stringify(evt.attendees),
        user_id: userId,
      });
    }

    const merged = mergeEvents(allCalEvents);

    const weekStart = getMondayOfWeek(now);
    const schedule = getWeeklySchedule(db, userId, weekStart);
    const todayDow = (now.getDay() + 6) % 7;
    const todaySchedule = schedule.find((s) => s.day_of_week === todayDow);
    const workStart = todaySchedule?.work_start ?? DEFAULT_WORK_START;
    const workEnd = todaySchedule?.work_end ?? DEFAULT_WORK_END;

    const { dayStart, dayEnd } = getWorkBoundariesUtc(now, workStart, workEnd);
    const todayEvents = merged.filter((e) => e.startTime >= dayStart && e.startTime < dayEnd);
    const freeSlots = findFreeSlots(todayEvents, dayStart, dayEnd);
    const conflicts = detectConflicts(todayEvents, freeSlots);

    expirePendingActions(db, userId, now.toISOString());

    for (const conflict of conflicts) {
      if (conflict.proposedMove) {
        const move = conflict.proposedMove;
        const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
        insertPendingAction(db, userId, {
          action_type: 'move_event',
          source_event_id: move.eventToMove.id,
          source: move.eventToMove.source,
          calendar_email: move.eventToMove.calendarEmail,
          description: conflict.suggestion ?? `Move "${move.eventToMove.title}"`,
          proposed_data: JSON.stringify({
            newStartTime: move.newStartTime,
            newEndTime: move.newEndTime,
            reason: move.reason,
          }),
          status: 'pending',
          expires_at: expiresAt,
        });
      }
    }

    const pendingActions = getPendingActions(db, userId);

    calendarData = {
      events: todayEvents,
      conflicts,
      freeSlots,
      pendingActions,
    };

    // Classify emails
    console.log('Classifying emails...');
    for (const email of allEmails) {
      try {
        const classified = await classifyEmail(email);
        allClassified.push(classified);

        getOrCreateSenderProfile(db, userId, classified.sender, classified.senderName);
        updateSenderProfile(db, userId, classified.sender, classified.category, classified.urgency);

        const action = determineAction(classified);

        if (action.type === 'archive') {
          await archiveOutlookEmail(classified.account, classified.id);
          totalArchived++;
        } else if (action.type === 'mark_read') {
          await markOutlookAsRead(classified.account, classified.id);
        }

        if (action.type === 'flag_for_review') {
          totalFlagged++;
        }

        await categorizeOutlookEmail(classified.account, classified.id, classified.category).catch(() => {});

        insertProcessedEmail(db, {
          id: classified.id,
          account: classified.account,
          sender: classified.sender,
          sender_name: classified.senderName,
          subject: classified.subject,
          received_at: classified.receivedAt,
          category: classified.category,
          urgency: classified.urgency,
          action_needed: classified.actionNeeded,
          action_taken: action.type,
          confidence: classified.confidence,
          summary: classified.summary,
          thread_id: classified.threadId,
          user_id: userId,
        });

        insertAuditLog(db, {
          action_type: action.type,
          target_id: classified.id,
          target_type: 'email',
          details: JSON.stringify({ category: classified.category, urgency: classified.urgency, reason: action.reason }),
          confidence: classified.confidence,
          user_id: userId,
        });

        totalProcessed++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Failed to process email ${email.id}: ${msg}`);
      }
    }

    // Fetch overnight dev report from NIGHTLY_PLAN.md (graceful failure)
    let overnightDevSummary: string | undefined;
    try {
      console.log('Fetching overnight dev report...');
      const nightlyPlan = await readRepoFile('claude_code', 'NIGHTLY_PLAN.md');
      if (nightlyPlan && nightlyPlan.trim().length > 0) {
        // Truncate to keep prompt reasonable — full plan can be long
        overnightDevSummary = nightlyPlan.length > 3000
          ? nightlyPlan.slice(0, 3000) + '\n...(truncated)'
          : nightlyPlan;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`Skipping overnight dev report: ${msg}`);
    }

    // Fetch production data from piece-work-scanner (graceful failure)
    let productionSection: string | undefined;
    try {
      if (config.pieceWorkScanner.url && config.pieceWorkScanner.apiKey) {
        console.log('Fetching production data...');
        const { fetchProductionSummary, formatProductionSection } = await import('./briefing/production.js');
        const productionData = await fetchProductionSummary(
          config.pieceWorkScanner.url,
          config.pieceWorkScanner.apiKey,
        );
        if (productionData) {
          productionSection = formatProductionSection(productionData);
          console.log('Production data included in briefing');
        } else {
          console.log('Production API returned no data — skipping production section');
        }
      } else {
        console.log('PIECE_WORK_SCANNER_URL or API_KEY not configured — skipping production section');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`Skipping production data: ${msg}`);
    }

    // Build user context for personalized briefing
    const prefs = getUserPreferences(db, userId);
    let userContext: UserBriefingContext | undefined;
    if (prefs) {
      userContext = {
        name: prefs.business_context ? userId : 'Rob McMillan',
        business_context: prefs.business_context,
      };
    }

    // Try to get user name from DB for briefing context
    try {
      const { getUserById } = await import('./db/user-queries.js');
      const user = getUserById(db, userId);
      if (user && userContext) {
        userContext.name = user.name;
      } else if (user && !userContext) {
        userContext = { name: user.name, business_context: null };
      }
    } catch {
      // Non-critical
    }

    // Include pending dev requests in the admin's briefing only.
    let pendingDevRequests: string | undefined;
    try {
      const user = getUserById(db, userId);
      if (user?.role === 'admin') {
        pendingDevRequests = formatPendingRequestsForBriefing(db);
      }
    } catch {
      // Non-critical
    }

    console.log('Generating morning briefing...');
    briefing = await generateBriefing(allClassified, {
      totalProcessed,
      archived: totalArchived,
      flaggedForReview: totalFlagged,
    }, calendarData, overnightDevSummary, productionSection, userContext, pendingDevRequests);

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Fatal error: ${msg}`);
    console.error('Fatal error:', msg);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  completeAgentRun(db, runId, {
    emails_processed: totalProcessed,
    actions_taken: totalArchived + totalFlagged,
    tokens_used: 0,
    cost_estimate: 0,
  });

  if (errors.length > 0) {
    console.warn(`Completed with ${errors.length} errors:`, errors);
  }

  console.log(`Triage complete in ${elapsed}s — ${totalProcessed} emails processed, ${totalArchived} archived, ${totalFlagged} flagged`);

  // Never return empty — if briefing generation failed, return error summary
  if (!briefing || briefing.trim().length === 0) {
    const errorSummary = errors.length > 0
      ? `Briefing generation failed.\n\nErrors:\n${errors.map((e) => `- ${e}`).join('\n')}`
      : `Briefing generation returned empty. ${totalProcessed} emails processed.`;
    return errorSummary;
  }

  return briefing;
}
