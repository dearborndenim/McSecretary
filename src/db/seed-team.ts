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

      const code = createInvite(db, member.id);
      invites.push({ name: member.name, code });
    }
  }

  return { invites };
}
