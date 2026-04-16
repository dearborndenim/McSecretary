/**
 * Admin CLI for managing McSecretary users.
 * Usage: npx tsx src/admin.ts <command> [options]
 *
 * Commands:
 *   add-user        --name <name> --email <email> --role <admin|member> [--timezone <tz>] [--briefing-cron <cron>]
 *   add-email       --user-id <id> --email <email> [--provider <provider>]
 *   set-preferences --user-id <id> [--business-context <text>] [--briefing-cron <cron>]
 *   list-users
 *   generate-invite --user-id <id>
 */

import type Database from 'better-sqlite3';
import crypto from 'node:crypto';
import {
  createUser,
  getAllUsers,
  addEmailAccount,
  setUserPreferences,
  getUserEmailAccounts,
  createInvite,
} from './db/user-queries.js';

export interface AdminCommand {
  action: string;
  args: Record<string, string>;
}

export function parseAdminCommand(argv: string[]): AdminCommand {
  const action = argv[0]!;
  const args: Record<string, string> = {};
  for (let i = 1; i < argv.length; i += 2) {
    const key = argv[i]!.replace(/^--/, '');
    args[key] = argv[i + 1] ?? '';
  }
  return { action, args };
}

export async function executeAdminCommand(db: Database.Database, cmd: AdminCommand): Promise<string> {
  switch (cmd.action) {
    case 'add-user': {
      const id = crypto.randomUUID();
      createUser(db, {
        id,
        name: cmd.args.name!,
        email: cmd.args.email!,
        role: (cmd.args.role as 'admin' | 'member') ?? 'member',
        timezone: cmd.args.timezone,
        briefing_cron: cmd.args['briefing-cron'],
      });
      const code = createInvite(db, id);
      return `Created user: ${cmd.args.name} (${id})\nInvite code: ${code}\nTell them to message the bot with: /start ${code}`;
    }

    case 'add-email': {
      const emailId = crypto.randomUUID();
      addEmailAccount(db, {
        id: emailId,
        user_id: cmd.args['user-id']!,
        email_address: cmd.args.email!,
        provider: cmd.args.provider ?? 'outlook',
      });
      return `Email account added: ${cmd.args.email}`;
    }

    case 'set-preferences': {
      const prefs: Record<string, string> = {};
      if (cmd.args['business-context']) prefs.business_context = cmd.args['business-context'];
      if (cmd.args['briefing-cron']) {
        db.prepare('UPDATE users SET briefing_cron = ? WHERE id = ?').run(
          cmd.args['briefing-cron'],
          cmd.args['user-id'],
        );
      }
      if (Object.keys(prefs).length > 0) {
        setUserPreferences(db, cmd.args['user-id']!, prefs);
      }
      return `Preferences updated for ${cmd.args['user-id']}`;
    }

    case 'list-users': {
      const users = getAllUsers(db);
      if (users.length === 0) return 'No users.';
      const lines = users.map((u) => {
        const accounts = getUserEmailAccounts(db, u.id);
        const emails = accounts.map((a) => a.email_address).join(', ');
        return `${u.name} (${u.role}) — ${u.email} | Telegram: ${u.telegram_chat_id ?? 'not linked'} | Accounts: ${emails || 'none'}`;
      });
      return lines.join('\n');
    }

    case 'generate-invite': {
      const code = createInvite(db, cmd.args['user-id']!);
      return `Invite code: ${code}\nExpires in 24 hours.`;
    }

    default:
      return `Unknown command: ${cmd.action}. Available: add-user, add-email, set-preferences, list-users, generate-invite`;
  }
}

// CLI entry point — only runs when executed directly
const isMainModule = process.argv[1]?.endsWith('admin.ts') || process.argv[1]?.endsWith('admin.js');
if (isMainModule) {
  (async () => {
    const { default: DatabaseConstructor } = await import('better-sqlite3');
    const { config } = await import('./config.js');
    const { initializeSchema } = await import('./db/schema.js');

    const db = new DatabaseConstructor(config.db.path);
    db.pragma('journal_mode = WAL');
    initializeSchema(db);

    const cmd = parseAdminCommand(process.argv.slice(2));
    try {
      const result = await executeAdminCommand(db, cmd);
      console.log(result);
    } catch (err) {
      console.error('Admin command failed:', err);
      process.exit(1);
    } finally {
      db.close();
    }
  })();
}
