/**
 * Seed Olivier and Merab as team members in the McSecretary DB.
 * Idempotent — safe to call on every startup.
 */

import type Database from 'better-sqlite3';
import {
  getUserById,
  createUser,
  addEmailAccount,
  setUserPreferences,
  createInvite,
  setUserScheduleWindows,
  DEFAULT_MEMBER_CHECK_IN,
  DEFAULT_MEMBER_EOD,
} from './user-queries.js';

const TEAM_MEMBERS = [
  {
    id: 'olivier',
    name: 'Olivier',
    email: 'olivier@dearborndenim.com',
    business_context:
      'Olivier works at Dearborn Denim. End user of kanban-purchaser, piece-work-scanner, and other operational tools.',
  },
  {
    id: 'merab',
    name: 'Merab',
    email: 'merab@dearborndenim.com',
    business_context:
      'Merab works at Dearborn Denim. End user of kanban-purchaser, piece-work-scanner, and other operational tools.',
  },
];

export function seedTeam(
  db: Database.Database,
): { invites: { name: string; code: string }[] } {
  const invites: { name: string; code: string }[] = [];

  for (const member of TEAM_MEMBERS) {
    const existing = getUserById(db, member.id);
    if (!existing) {
      createUser(db, {
        id: member.id,
        name: member.name,
        email: member.email,
        role: 'member',
      });

      addEmailAccount(db, {
        id: `${member.id}-dd`,
        user_id: member.id,
        email_address: member.email,
        provider: 'outlook',
      });

      setUserPreferences(db, member.id, {
        business_context: member.business_context,
      });

      // Member default schedule: 6 AM – 2 PM check-ins + 2:30 PM EOD, Mon-Fri.
      setUserScheduleWindows(db, member.id, {
        check_in_cron: DEFAULT_MEMBER_CHECK_IN,
        eod_cron: DEFAULT_MEMBER_EOD,
      });

      const code = createInvite(db, member.id);
      invites.push({ name: member.name, code });
    } else {
      // Backfill schedule windows on an already-seeded member that was created
      // before the per-user schedule columns existed.
      if (existing.check_in_cron === null || existing.eod_cron === null) {
        setUserScheduleWindows(db, member.id, {
          check_in_cron: existing.check_in_cron ?? DEFAULT_MEMBER_CHECK_IN,
          eod_cron: existing.eod_cron ?? DEFAULT_MEMBER_EOD,
        });
      }
    }
  }

  return { invites };
}
