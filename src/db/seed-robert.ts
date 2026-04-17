import type Database from 'better-sqlite3';
import {
  getUserById,
  createUser,
  addEmailAccount,
  setUserPreferences,
  setUserScheduleWindows,
  DEFAULT_ADMIN_CHECK_IN,
  DEFAULT_ADMIN_EOD,
} from './user-queries.js';

const ROBERT_ID = 'robert-mcmillan';

export function seedRobert(db: Database.Database, telegramChatId: string): void {
  const existing = getUserById(db, ROBERT_ID);
  if (!existing) {
    createUser(db, {
      id: ROBERT_ID,
      name: 'Robert McMillan',
      email: 'rob@dearborndenim.com',
      role: 'admin',
      telegram_chat_id: telegramChatId,
    });

    addEmailAccount(db, {
      id: 'robert-dd',
      user_id: ROBERT_ID,
      email_address: 'rob@dearborndenim.com',
      provider: 'outlook',
    });

    addEmailAccount(db, {
      id: 'robert-mm',
      user_id: ROBERT_ID,
      email_address: 'robert@mcmillan-manufacturing.com',
      provider: 'outlook',
    });

    setUserPreferences(db, ROBERT_ID, {
      business_context: 'Robert McMillan owns Dearborn Denim (rob@dearborndenim.com) — a denim/jeans company with retail + wholesale, and McMillan Manufacturing (robert@mcmillan-manufacturing.com) — contract manufacturing. He also runs an AI agent empire that automates business operations.',
    });

    setUserScheduleWindows(db, ROBERT_ID, {
      check_in_cron: DEFAULT_ADMIN_CHECK_IN,
      eod_cron: DEFAULT_ADMIN_EOD,
    });
  } else if (existing.check_in_cron === null || existing.eod_cron === null) {
    setUserScheduleWindows(db, ROBERT_ID, {
      check_in_cron: existing.check_in_cron ?? DEFAULT_ADMIN_CHECK_IN,
      eod_cron: existing.eod_cron ?? DEFAULT_ADMIN_EOD,
    });
  }

  // Backfill user_id on existing rows that have no user_id
  const tables = [
    'processed_emails',
    'sender_profiles',
    'agent_runs',
    'audit_log',
    'calendar_events',
    'weekly_schedule',
    'pending_actions',
    'time_log',
    'conversation_log',
  ];

  for (const table of tables) {
    db.prepare(`UPDATE ${table} SET user_id = ? WHERE user_id IS NULL`).run(ROBERT_ID);
  }
}

export { ROBERT_ID };
