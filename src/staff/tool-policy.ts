/**
 * Which chat tools a user may see and call (staff access spec §7.1).
 *
 * An admin gets every tool, unchanged. Anyone else gets only the PERSONAL
 * tools, which act on their own linked mailbox and calendar. Everything else
 * is admin-only, and so is any tool name this file does not list: a new tool
 * stays invisible to members until someone classifies it here (fail closed).
 *
 * Build 2 adds the staff-action catalogue tools on top of PERSONAL.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { isEmpireTool } from '../empire/tools.js';
import { isGraphTool } from '../graph/tools.js';

/** The fields of a users row this policy reads. */
export interface ToolPolicyUser {
  role: string;
}

/**
 * Tools that act only on the calling user's own Outlook mailbox and calendar
 * (executeTool scopes them by userId; checkToolCall pins `account` to the
 * user's own linked addresses).
 *
 * Microsoft To Do is NOT here: src/tasks/todo.ts reads and writes the single
 * default mailbox (defaultOutlookMailbox(), i.e. Robert's) and getTaskLists()
 * takes no user or account parameter, so its tools would expose Robert's
 * lists to anyone. They stay admin-only until the To Do module is scoped per
 * user.
 */
export const PERSONAL_TOOLS: ReadonlySet<string> = new Set([
  // email
  'archive_email',
  'categorize_email',
  'mark_email_read',
  'send_email',
  'read_contacts',
  'bulk_archive_emails',
  'bulk_categorize_emails',
  'archive_emails_by_category',
  'list_email_categories',
  'create_email_category',
  // calendar
  'list_calendar_events',
  'create_calendar_event',
  'update_calendar_event',
  'delete_calendar_event',
]);

/**
 * Listed for readers; any name outside PERSONAL_TOOLS is admin-only anyway.
 * Schedule tools change global jobs, the journal is Robert's, To Do is
 * Robert's mailbox (see above), and every empire (GitHub) and graph tool.
 */
export const ADMIN_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'update_schedule',
  'toggle_schedule',
  'view_schedule',
  'check_journal_health',
  'create_todo_task',
  'complete_todo_task',
  'list_todo_tasks',
  'get_completed_tasks',
]);

export function isAdminUser(user: ToolPolicyUser): boolean {
  return user.role === 'admin';
}

/** True only for names classified PERSONAL; empire, graph and unknown names are admin-only. */
export function isPersonalTool(name: string): boolean {
  if (isEmpireTool(name) || isGraphTool(name) || ADMIN_ONLY_TOOLS.has(name)) return false;
  return PERSONAL_TOOLS.has(name);
}

export function isToolAllowed(user: ToolPolicyUser, name: string): boolean {
  if (isAdminUser(user)) return true;
  return isPersonalTool(name);
}

/** The tool definitions to send to the API for this user. An admin gets `allTools` itself. */
export function toolsForUser(user: ToolPolicyUser, allTools: Anthropic.Tool[]): Anthropic.Tool[] {
  if (isAdminUser(user)) return allTools;
  return allTools.filter((t) => isToolAllowed(user, t.name));
}

/**
 * Defence in depth for one tool call from the chat loop, checked before
 * executeTool. Returns a refusal sentence to hand back to the model as the
 * tool result, or null when the call may run. Never throws.
 *
 * Besides the name check, a member's `account` must be one of their own
 * linked addresses: the Graph app reads and sends for any mailbox in the
 * tenant, so an unchecked `account` would let a member act on Robert's mail.
 * When `account` is omitted the executor already falls back to the user's own
 * accounts.
 */
export function checkToolCall(
  user: ToolPolicyUser,
  name: string,
  input: unknown,
  ownAccounts: string[],
): string | null {
  if (isAdminUser(user)) return null;
  if (!isToolAllowed(user, name)) {
    return `The tool ${name} is not available to you. Nothing was done; ask Robert if you need it.`;
  }
  const account = input && typeof input === 'object' ? (input as Record<string, unknown>).account : undefined;
  if (account !== undefined && account !== null) {
    const own = new Set(ownAccounts.map((a) => a.toLowerCase()));
    if (typeof account !== 'string' || !own.has(account.trim().toLowerCase())) {
      return `You can only use your own linked email accounts (${ownAccounts.join(', ') || 'none linked'}). Nothing was done.`;
    }
  }
  return null;
}
