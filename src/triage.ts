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
import { fetchUnreadOutlookEmails } from './email/outlook.js';
import { fetchUnreadGmailEmails } from './email/gmail.js';
import { isGmailConfigured } from './auth/google.js';
import { classifyEmail } from './email/classifier.js';
import { determineAction, archiveOutlookEmail, markOutlookAsRead, categorizeOutlookEmail } from './email/actions.js';
import { generateBriefing } from './briefing/generator.js';
import { readRepoFile } from './empire/github.js';
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

export async function runTriage(db: Database.Database): Promise<string> {
  console.log('McSECREtary — triage starting...');
  const startTime = Date.now();

  const { config } = await import('./config.js');

  const runId = insertAgentRun(db, 'overnight');
  const lastRun = getLastRunTimestamp(db, 'overnight');

  let totalProcessed = 0;
  let totalArchived = 0;
  let totalFlagged = 0;
  const allClassified: ClassifiedEmail[] = [];
  const errors: string[] = [];
  let calendarData: CalendarBriefingData | undefined;
  let briefing = '';

  try {
    console.log('Fetching emails and calendar...');

    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 2);
    const calStartDate = now.toISOString();
    const calEndDate = tomorrow.toISOString();

    const gmailConfigured = isGmailConfigured();

    const [outlook1, outlook2, gmail, calEvents1, calEvents2] = await Promise.all([
      fetchUnreadOutlookEmails(config.outlook.email1, lastRun).catch((err) => {
        errors.push(`Outlook1 fetch failed: ${err.message}`);
        return [] as RawEmail[];
      }),
      fetchUnreadOutlookEmails(config.outlook.email2, lastRun).catch((err) => {
        errors.push(`Outlook2 fetch failed: ${err.message}`);
        return [] as RawEmail[];
      }),
      gmailConfigured
        ? fetchUnreadGmailEmails(config.gmail.email, lastRun).catch((err) => {
            errors.push(`Gmail fetch failed: ${err.message}`);
            return [] as RawEmail[];
          })
        : Promise.resolve([] as RawEmail[]),
      fetchOutlookCalendarEvents(config.outlook.email1, calStartDate, calEndDate).catch((err) => {
        errors.push(`Outlook1 calendar fetch failed: ${err.message}`);
        return [] as UnifiedEvent[];
      }),
      fetchOutlookCalendarEvents(config.outlook.email2, calStartDate, calEndDate).catch((err) => {
        errors.push(`Outlook2 calendar fetch failed: ${err.message}`);
        return [] as UnifiedEvent[];
      }),
    ]);

    const allEmails = [...outlook1, ...outlook2, ...gmail];
    console.log(`Fetched ${allEmails.length} unread emails (${outlook1.length} OL1, ${outlook2.length} OL2, ${gmail.length} Gmail)`);

    // Process calendar
    console.log('Processing calendar...');
    const allCalEvents = [...calEvents1, ...calEvents2];
    console.log(`Fetched ${allCalEvents.length} calendar events (${calEvents1.length} OL1, ${calEvents2.length} OL2)`);

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
      });
    }

    const merged = mergeEvents(allCalEvents);

    const weekStart = getMondayOfWeek(now);
    const schedule = getWeeklySchedule(db, weekStart);
    const todayDow = (now.getDay() + 6) % 7;
    const todaySchedule = schedule.find((s) => s.day_of_week === todayDow);
    const workStart = todaySchedule?.work_start ?? DEFAULT_WORK_START;
    const workEnd = todaySchedule?.work_end ?? DEFAULT_WORK_END;

    const { dayStart, dayEnd } = getWorkBoundariesUtc(now, workStart, workEnd);
    const todayEvents = merged.filter((e) => e.startTime >= dayStart && e.startTime < dayEnd);
    const freeSlots = findFreeSlots(todayEvents, dayStart, dayEnd);
    const conflicts = detectConflicts(todayEvents, freeSlots);

    expirePendingActions(db, now.toISOString());

    for (const conflict of conflicts) {
      if (conflict.proposedMove) {
        const move = conflict.proposedMove;
        const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
        insertPendingAction(db, {
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

    const pendingActions = getPendingActions(db);

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

        getOrCreateSenderProfile(db, classified.sender, classified.senderName);
        updateSenderProfile(db, classified.sender, classified.category, classified.urgency);

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
        });

        insertAuditLog(db, {
          action_type: action.type,
          target_id: classified.id,
          target_type: 'email',
          details: JSON.stringify({ category: classified.category, urgency: classified.urgency, reason: action.reason }),
          confidence: classified.confidence,
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
      // Don't add to errors array — this is optional enrichment
    }

    console.log('Generating morning briefing...');
    briefing = await generateBriefing(allClassified, {
      totalProcessed,
      archived: totalArchived,
      flaggedForReview: totalFlagged,
    }, calendarData, overnightDevSummary);

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
