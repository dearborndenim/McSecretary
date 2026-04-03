import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { config } from './config.js';
import { initializeSchema } from './db/schema.js';
import {
  insertProcessedEmail,
  getOrCreateSenderProfile,
  updateSenderProfile,
  insertAgentRun,
  completeAgentRun,
  insertAuditLog,
  getLastRunTimestamp,
} from './db/queries.js';
import { fetchUnreadOutlookEmails } from './email/outlook.js';
import { fetchUnreadGmailEmails } from './email/gmail.js';
import { classifyEmail } from './email/classifier.js';
import { determineAction, archiveOutlookEmail, markOutlookAsRead, categorizeOutlookEmail } from './email/actions.js';
import { generateBriefing } from './briefing/generator.js';
import { sendBriefingEmail } from './briefing/sender.js';
import type { RawEmail, ClassifiedEmail } from './email/types.js';

async function main() {
  console.log('McSECREtary — overnight triage starting...');
  const startTime = Date.now();

  // Ensure data directory exists
  const dbDir = path.dirname(config.db.path);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  // Initialize database
  const db = new Database(config.db.path);
  db.pragma('journal_mode = WAL');
  initializeSchema(db);

  // Start run tracking
  const runId = insertAgentRun(db, 'overnight');
  const lastRun = getLastRunTimestamp(db, 'overnight');

  let totalProcessed = 0;
  let totalArchived = 0;
  let totalFlagged = 0;
  const allClassified: ClassifiedEmail[] = [];
  const errors: string[] = [];

  try {
    // 1. Fetch emails from all accounts
    console.log('Fetching emails...');

    const [outlook1, outlook2, gmail] = await Promise.all([
      fetchUnreadOutlookEmails(config.outlook.email1, lastRun).catch((err) => {
        errors.push(`Outlook1 fetch failed: ${err.message}`);
        return [] as RawEmail[];
      }),
      fetchUnreadOutlookEmails(config.outlook.email2, lastRun).catch((err) => {
        errors.push(`Outlook2 fetch failed: ${err.message}`);
        return [] as RawEmail[];
      }),
      fetchUnreadGmailEmails(lastRun).catch((err) => {
        errors.push(`Gmail fetch failed: ${err.message}`);
        return [] as RawEmail[];
      }),
    ]);

    const allEmails = [...outlook1, ...outlook2, ...gmail];
    console.log(`Fetched ${allEmails.length} unread emails (${outlook1.length} OL1, ${outlook2.length} OL2, ${gmail.length} Gmail)`);

    // 2. Classify each email
    console.log('Classifying emails...');
    for (const email of allEmails) {
      try {
        const classified = await classifyEmail(email);
        allClassified.push(classified);

        // 3. Update sender profile
        getOrCreateSenderProfile(db, classified.sender, classified.senderName);
        updateSenderProfile(db, classified.sender, classified.category, classified.urgency);

        // 4. Determine and execute action
        const action = determineAction(classified);

        if (action.type === 'archive' && classified.account !== config.gmail.userEmail) {
          await archiveOutlookEmail(classified.account, classified.id);
          totalArchived++;
        } else if (action.type === 'mark_read' && classified.account !== config.gmail.userEmail) {
          await markOutlookAsRead(classified.account, classified.id);
        }

        if (action.type === 'flag_for_review') {
          totalFlagged++;
        }

        // Categorize Outlook emails
        if (classified.account !== config.gmail.userEmail) {
          await categorizeOutlookEmail(classified.account, classified.id, classified.category).catch(() => {
            // Category might not exist yet — non-critical
          });
        }

        // 5. Store in database
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

    // 6. Generate and send morning briefing
    console.log('Generating morning briefing...');
    const briefing = await generateBriefing(allClassified, {
      totalProcessed,
      archived: totalArchived,
      flaggedForReview: totalFlagged,
    });

    console.log('Sending briefing email...');
    await sendBriefingEmail(briefing);

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Fatal error: ${msg}`);
    console.error('Fatal error:', msg);
  }

  // 7. Complete run tracking
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

  console.log(`McSECREtary run complete in ${elapsed}s — ${totalProcessed} emails processed, ${totalArchived} archived, ${totalFlagged} flagged`);

  db.close();
}

main().catch((err) => {
  console.error('McSECREtary crashed:', err);
  process.exit(1);
});
