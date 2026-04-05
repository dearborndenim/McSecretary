/**
 * Tool definitions for Claude's tool_use feature.
 * These give the AI secretary the ability to execute real actions.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type Database from 'better-sqlite3';
import { archiveOutlookEmail, markOutlookAsRead, categorizeOutlookEmail } from './email/actions.js';
import {
  getFormattedTaskLists,
  findOrCreateTaskList,
  createTask,
  completeTask,
  getIncompleteTasks,
} from './tasks/todo.js';
import {
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
} from './calendar/calendar-actions.js';
import {
  updateScheduleAndRestart,
  toggleScheduledTask,
  getScheduleStatus,
} from './scheduler.js';

// DB reference — set during init
let _db: Database.Database | null = null;

export function setToolsDb(db: Database.Database): void {
  _db = db;
}

function getDb(): Database.Database {
  if (!_db) throw new Error('Tools DB not initialized. Call setToolsDb() first.');
  return _db;
}

// Tool definitions for Claude API
export const TOOL_DEFINITIONS: Anthropic.Tool[] = [
  {
    name: 'archive_email',
    description: 'Archive an email in Outlook. Use when Rob asks to archive, clean up, or remove an email.',
    input_schema: {
      type: 'object' as const,
      properties: {
        account: { type: 'string', description: 'Email account (rob@dearborndenim.com or robert@mcmillan-manufacturing.com)' },
        email_id: { type: 'string', description: 'The email message ID' },
      },
      required: ['account', 'email_id'],
    },
  },
  {
    name: 'categorize_email',
    description: 'Apply a category/label to an email in Outlook. Use when Rob asks to tag, label, or categorize an email.',
    input_schema: {
      type: 'object' as const,
      properties: {
        account: { type: 'string', description: 'Email account' },
        email_id: { type: 'string', description: 'The email message ID' },
        category: { type: 'string', description: 'Category name to apply (e.g., "spam", "customer", "supplier", "follow-up")' },
      },
      required: ['account', 'email_id', 'category'],
    },
  },
  {
    name: 'mark_email_read',
    description: 'Mark an email as read in Outlook.',
    input_schema: {
      type: 'object' as const,
      properties: {
        account: { type: 'string', description: 'Email account' },
        email_id: { type: 'string', description: 'The email message ID' },
      },
      required: ['account', 'email_id'],
    },
  },
  {
    name: 'send_email',
    description: 'Send an email from one of Rob\'s Outlook accounts. ALWAYS ask Rob for approval before sending. Use when Rob asks you to draft and send an email or reply.',
    input_schema: {
      type: 'object' as const,
      properties: {
        account: { type: 'string', description: 'Send from this account (rob@dearborndenim.com or robert@mcmillan-manufacturing.com)' },
        to: { type: 'array', items: { type: 'string' }, description: 'Recipient email addresses' },
        subject: { type: 'string', description: 'Email subject line' },
        body: { type: 'string', description: 'Email body text' },
        reply_to_id: { type: 'string', description: 'If replying to an email, the original message ID (optional)' },
      },
      required: ['account', 'to', 'subject', 'body'],
    },
  },
  {
    name: 'read_contacts',
    description: 'Search or list contacts from Outlook. Use when Rob asks about a contact, needs an email address, or wants to look someone up.',
    input_schema: {
      type: 'object' as const,
      properties: {
        account: { type: 'string', description: 'Email account (optional, defaults to rob@dearborndenim.com)' },
        search: { type: 'string', description: 'Search term — name, email, or company (optional, lists all if omitted)' },
        limit: { type: 'number', description: 'Max results (default 20)' },
      },
      required: [],
    },
  },
  {
    name: 'create_todo_task',
    description: 'Create a new task in Microsoft To Do. Use when Rob asks to add a task, reminder, or todo item.',
    input_schema: {
      type: 'object' as const,
      properties: {
        list_name: { type: 'string', description: 'Task list name (e.g., "Tasks", "Dearborn Denim", "McMillan Manufacturing")' },
        title: { type: 'string', description: 'Task title' },
        importance: { type: 'string', enum: ['low', 'normal', 'high'], description: 'Task importance' },
        due_date: { type: 'string', description: 'Due date in YYYY-MM-DD format (optional)' },
        body: { type: 'string', description: 'Additional notes for the task (optional)' },
      },
      required: ['list_name', 'title'],
    },
  },
  {
    name: 'complete_todo_task',
    description: 'Mark a task as completed in Microsoft To Do.',
    input_schema: {
      type: 'object' as const,
      properties: {
        list_name: { type: 'string', description: 'Task list name' },
        task_title: { type: 'string', description: 'Title of the task to complete (will match closest)' },
      },
      required: ['list_name', 'task_title'],
    },
  },
  {
    name: 'list_todo_tasks',
    description: 'List incomplete tasks from Microsoft To Do.',
    input_schema: {
      type: 'object' as const,
      properties: {
        list_name: { type: 'string', description: 'Task list name (optional — lists all if omitted)' },
      },
      required: [],
    },
  },
  {
    name: 'get_completed_tasks',
    description: 'List recently completed tasks from Microsoft To Do. Use when Rob asks what he got done, or to check completed work.',
    input_schema: {
      type: 'object' as const,
      properties: {
        list_name: { type: 'string', description: 'Task list name (optional — checks all if omitted)' },
        limit: { type: 'number', description: 'Max results (default 10)' },
      },
      required: [],
    },
  },
  {
    name: 'archive_emails_by_category',
    description: 'Archive ALL emails with a specific category/tag. Use when Rob says "archive all spam" or "archive emails tagged X". This finds and archives all matching emails in one operation.',
    input_schema: {
      type: 'object' as const,
      properties: {
        account: { type: 'string', description: 'Email account (optional, processes both if omitted)' },
        category: { type: 'string', description: 'Category name to search for (e.g., "spam", "newsletter")' },
      },
      required: ['category'],
    },
  },
  // Email category tools
  {
    name: 'list_email_categories',
    description: 'List all available email categories/labels defined in Outlook. Use to see what categories exist before tagging.',
    input_schema: {
      type: 'object' as const,
      properties: {
        account: { type: 'string', description: 'Email account (optional, defaults to rob@dearborndenim.com)' },
      },
      required: [],
    },
  },
  {
    name: 'create_email_category',
    description: 'Create a new email category/label in Outlook. Use when Rob wants a new tag that does not exist yet.',
    input_schema: {
      type: 'object' as const,
      properties: {
        account: { type: 'string', description: 'Email account (optional)' },
        name: { type: 'string', description: 'Category display name (e.g., "Apollo Response", "Follow Up", "VIP Customer")' },
        color: { type: 'string', description: 'Color preset (preset0-preset24, or "none"). Optional.' },
      },
      required: ['name'],
    },
  },
  // Calendar tools
  {
    name: 'list_calendar_events',
    description: 'Fetch calendar events for a date range. Use this FIRST when Rob asks about his schedule or before modifying/deleting events — you need the event IDs.',
    input_schema: {
      type: 'object' as const,
      properties: {
        account: { type: 'string', description: 'Email account (optional, fetches from both if omitted)' },
        start_date: { type: 'string', description: 'Start date YYYY-MM-DD (defaults to today)' },
        end_date: { type: 'string', description: 'End date YYYY-MM-DD (defaults to tomorrow)' },
      },
      required: [],
    },
  },
  {
    name: 'create_calendar_event',
    description: 'Create a new calendar event in Outlook. Use when Rob asks to schedule a meeting, block time, or add an event.',
    input_schema: {
      type: 'object' as const,
      properties: {
        account: { type: 'string', description: 'Email account (optional, defaults to rob@dearborndenim.com)' },
        subject: { type: 'string', description: 'Event title/subject' },
        start: { type: 'string', description: 'Start time in YYYY-MM-DDTHH:MM:SS format (Chicago time)' },
        end: { type: 'string', description: 'End time in YYYY-MM-DDTHH:MM:SS format (Chicago time)' },
        location: { type: 'string', description: 'Location (optional)' },
        body: { type: 'string', description: 'Event description/notes (optional)' },
        attendees: { type: 'array', items: { type: 'string' }, description: 'Email addresses of attendees (optional)' },
        is_online: { type: 'boolean', description: 'Create as Teams meeting (optional)' },
      },
      required: ['subject', 'start', 'end'],
    },
  },
  {
    name: 'update_calendar_event',
    description: 'Update an existing calendar event. Use when Rob asks to reschedule, rename, or modify an event.',
    input_schema: {
      type: 'object' as const,
      properties: {
        account: { type: 'string', description: 'Email account (optional)' },
        event_id: { type: 'string', description: 'The event ID to update' },
        subject: { type: 'string', description: 'New title (optional)' },
        start: { type: 'string', description: 'New start time YYYY-MM-DDTHH:MM:SS (optional)' },
        end: { type: 'string', description: 'New end time YYYY-MM-DDTHH:MM:SS (optional)' },
        location: { type: 'string', description: 'New location (optional)' },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'delete_calendar_event',
    description: 'Delete/cancel a calendar event. Use when Rob asks to cancel or remove a meeting.',
    input_schema: {
      type: 'object' as const,
      properties: {
        account: { type: 'string', description: 'Email account (optional)' },
        event_id: { type: 'string', description: 'The event ID to delete' },
      },
      required: ['event_id'],
    },
  },
  // Schedule management tools
  {
    name: 'update_schedule',
    description: 'Change the schedule of a recurring task (e.g., move briefing to 5 AM, change check-in frequency). Use cron syntax.',
    input_schema: {
      type: 'object' as const,
      properties: {
        task_name: { type: 'string', description: 'Task name: "Morning Briefing", "Hourly Check-In", "Evening Summary", or "Weekly Synthesis"' },
        cron_expression: { type: 'string', description: 'New cron expression (e.g., "0 5 * * 1-5" for 5 AM weekdays)' },
        description: { type: 'string', description: 'Updated description (optional)' },
      },
      required: ['task_name', 'cron_expression'],
    },
  },
  {
    name: 'toggle_schedule',
    description: 'Enable or disable a scheduled task. Use when Rob wants to pause or resume a recurring task.',
    input_schema: {
      type: 'object' as const,
      properties: {
        task_name: { type: 'string', description: 'Task name' },
        enabled: { type: 'boolean', description: 'true to enable, false to disable' },
      },
      required: ['task_name', 'enabled'],
    },
  },
  {
    name: 'view_schedule',
    description: 'Show the current schedule of all recurring tasks with their cron expressions and status.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
];

// Tool execution
export async function executeTool(name: string, input: Record<string, any>): Promise<string> {
  try {
    switch (name) {
      case 'archive_email': {
        await archiveOutlookEmail(input.account, input.email_id);
        return `Email archived successfully.`;
      }

      case 'categorize_email': {
        await categorizeOutlookEmail(input.account, input.email_id, input.category);
        return `Email categorized as "${input.category}".`;
      }

      case 'mark_email_read': {
        await markOutlookAsRead(input.account, input.email_id);
        return `Email marked as read.`;
      }

      case 'send_email': {
        const { getGraphToken } = await import('./auth/graph.js');
        const token = await getGraphToken();

        if (input.reply_to_id) {
          // Reply to existing message
          const res = await fetch(`https://graph.microsoft.com/v1.0/users/${input.account}/messages/${input.reply_to_id}/reply`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              comment: input.body,
            }),
          });
          if (!res.ok) {
            const text = await res.text();
            return `Failed to send reply: ${res.status} ${text}`;
          }
          return `Reply sent from ${input.account}.`;
        }

        // New email
        const res = await fetch(`https://graph.microsoft.com/v1.0/users/${input.account}/sendMail`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            message: {
              subject: input.subject,
              body: { contentType: 'text', content: input.body },
              toRecipients: input.to.map((email: string) => ({
                emailAddress: { address: email },
              })),
            },
          }),
        });

        if (!res.ok) {
          const text = await res.text();
          return `Failed to send email: ${res.status} ${text}`;
        }
        return `Email sent from ${input.account} to ${input.to.join(', ')}. Subject: "${input.subject}"`;
      }

      case 'read_contacts': {
        const { getGraphToken } = await import('./auth/graph.js');
        const { config } = await import('./config.js');
        const token = await getGraphToken();
        const email = input.account ?? config.outlook.email1;
        const limit = input.limit ?? 20;

        let url: string;
        if (input.search) {
          const q = encodeURIComponent(input.search);
          url = `https://graph.microsoft.com/v1.0/users/${email}/contacts?$filter=contains(displayName,'${q}') or contains(emailAddresses/any(e:e/address),'${q}')&$top=${limit}&$select=displayName,emailAddresses,companyName,jobTitle,mobilePhone,businessPhones`;
        } else {
          url = `https://graph.microsoft.com/v1.0/users/${email}/contacts?$top=${limit}&$orderby=displayName&$select=displayName,emailAddresses,companyName,jobTitle,mobilePhone,businessPhones`;
        }

        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${token}` },
        });

        if (!res.ok) {
          // Filter on contacts can be tricky — try simpler approach
          if (input.search) {
            const simpleUrl = `https://graph.microsoft.com/v1.0/users/${email}/contacts?$search="${encodeURIComponent(input.search)}"&$top=${limit}&$select=displayName,emailAddresses,companyName,jobTitle,mobilePhone,businessPhones`;
            const res2 = await fetch(simpleUrl, {
              headers: {
                Authorization: `Bearer ${token}`,
                ConsistencyLevel: 'eventual',
              },
            });
            if (!res2.ok) {
              const text = await res2.text();
              return `Failed to search contacts: ${res2.status} ${text}`;
            }
            const data2 = (await res2.json()) as { value: any[] };
            if (data2.value.length === 0) return `No contacts found matching "${input.search}".`;
            return data2.value.map((c: any) => {
              const emails = (c.emailAddresses ?? []).map((e: any) => e.address).join(', ');
              const phone = c.mobilePhone || (c.businessPhones ?? [])[0] || '';
              return `- ${c.displayName}${c.companyName ? ` (${c.companyName})` : ''}${c.jobTitle ? ` — ${c.jobTitle}` : ''}\n  Email: ${emails || '(none)'}\n  Phone: ${phone || '(none)'}`;
            }).join('\n');
          }
          const text = await res.text();
          return `Failed to list contacts: ${res.status} ${text}`;
        }

        const data = (await res.json()) as { value: any[] };
        if (data.value.length === 0) return input.search ? `No contacts found matching "${input.search}".` : 'No contacts found.';

        return data.value.map((c: any) => {
          const emails = (c.emailAddresses ?? []).map((e: any) => e.address).join(', ');
          const phone = c.mobilePhone || (c.businessPhones ?? [])[0] || '';
          return `- ${c.displayName}${c.companyName ? ` (${c.companyName})` : ''}${c.jobTitle ? ` — ${c.jobTitle}` : ''}\n  Email: ${emails || '(none)'}\n  Phone: ${phone || '(none)'}`;
        }).join('\n');
      }

      case 'create_todo_task': {
        const list = await findOrCreateTaskList(input.list_name);
        const task = await createTask(list.id, input.title, {
          importance: input.importance,
          dueDate: input.due_date,
          body: input.body,
        });
        return `Task created: "${task.title}" in list "${input.list_name}".`;
      }

      case 'complete_todo_task': {
        const list = await findOrCreateTaskList(input.list_name);
        const tasks = await getIncompleteTasks(list.id);
        const match = tasks.find((t) =>
          t.title.toLowerCase().includes(input.task_title.toLowerCase()),
        );
        if (!match) {
          return `No matching task found for "${input.task_title}" in "${input.list_name}".`;
        }
        await completeTask(list.id, match.id);
        return `Task completed: "${match.title}".`;
      }

      case 'list_todo_tasks': {
        if (input.list_name) {
          const list = await findOrCreateTaskList(input.list_name);
          const tasks = await getIncompleteTasks(list.id);
          if (tasks.length === 0) return `No incomplete tasks in "${input.list_name}".`;
          return tasks.map((t) => `- ${t.title}${t.importance === 'high' ? ' [HIGH]' : ''}`).join('\n');
        }
        return await getFormattedTaskLists();
      }

      case 'get_completed_tasks': {
        const { getCompletedTasks, getTaskLists } = await import('./tasks/todo.js');
        const limit = input.limit ?? 10;

        if (input.list_name) {
          const list = await findOrCreateTaskList(input.list_name);
          const tasks = await getCompletedTasks(list.id, limit);
          if (tasks.length === 0) return `No completed tasks in "${input.list_name}".`;
          return tasks.map((t) => {
            const completed = t.completedDateTime ? ` (completed: ${t.completedDateTime.dateTime})` : '';
            return `- [DONE] ${t.title}${completed}`;
          }).join('\n');
        }

        const lists = await getTaskLists();
        const results: string[] = [];
        for (const list of lists) {
          const tasks = await getCompletedTasks(list.id, limit);
          if (tasks.length > 0) {
            const taskList = tasks.map((t) => {
              const completed = t.completedDateTime ? ` (completed: ${t.completedDateTime.dateTime})` : '';
              return `  - [DONE] ${t.title}${completed}`;
            }).join('\n');
            results.push(`${list.displayName}:\n${taskList}`);
          }
        }
        return results.length > 0 ? results.join('\n\n') : 'No completed tasks found.';
      }

      case 'archive_emails_by_category': {
        const { getGraphToken } = await import('./auth/graph.js');
        const { config } = await import('./config.js');
        const token = await getGraphToken();

        const accounts = input.account
          ? [input.account]
          : [config.outlook.email1, config.outlook.email2];

        let totalArchived = 0;
        let totalFailed = 0;

        for (const acct of accounts) {
          // Find all emails with this category
          const filterUrl = `https://graph.microsoft.com/v1.0/users/${acct}/messages?$filter=${encodeURIComponent(`categories/any(c:c eq '${input.category}')`)}&$top=100&$select=id,subject`;
          const listRes = await fetch(filterUrl, {
            headers: { Authorization: `Bearer ${token}` },
          });

          if (!listRes.ok) {
            const text = await listRes.text();
            return `Failed to search emails by category: ${listRes.status} ${text}`;
          }

          const data = (await listRes.json()) as { value: { id: string; subject: string }[] };

          for (const msg of data.value) {
            try {
              await archiveOutlookEmail(acct, msg.id);
              totalArchived++;
            } catch {
              totalFailed++;
            }
          }
        }

        if (totalArchived === 0 && totalFailed === 0) {
          return `No emails found with category "${input.category}".`;
        }

        let result = `Archived ${totalArchived} email${totalArchived !== 1 ? 's' : ''} tagged "${input.category}".`;
        if (totalFailed > 0) result += ` ${totalFailed} failed.`;
        return result;
      }

      // Email category tools
      case 'list_email_categories': {
        const { getGraphToken } = await import('./auth/graph.js');
        const { config } = await import('./config.js');
        const token = await getGraphToken();
        const email = input.account ?? config.outlook.email1;

        const res = await fetch(`https://graph.microsoft.com/v1.0/users/${email}/outlook/masterCategories`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
          const text = await res.text();
          return `Failed to list categories: ${res.status} ${text}`;
        }
        const data = (await res.json()) as { value: { displayName: string; color: string }[] };
        if (data.value.length === 0) return 'No categories defined.';
        return data.value.map((c) => `- ${c.displayName} (${c.color})`).join('\n');
      }

      case 'create_email_category': {
        const { getGraphToken } = await import('./auth/graph.js');
        const { config } = await import('./config.js');
        const token = await getGraphToken();
        const email = input.account ?? config.outlook.email1;

        const res = await fetch(`https://graph.microsoft.com/v1.0/users/${email}/outlook/masterCategories`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            displayName: input.name,
            color: input.color ?? 'none',
          }),
        });
        if (!res.ok) {
          const text = await res.text();
          return `Failed to create category: ${res.status} ${text}`;
        }
        const created = await res.json();
        return `Category created: "${created.displayName}" (${created.color})`;
      }

      // Calendar tools
      case 'list_calendar_events': {
        const { fetchOutlookCalendarEvents } = await import('./calendar/outlook-calendar.js');
        const { config } = await import('./config.js');

        const today = new Date();
        const startDate = input.start_date
          ? new Date(`${input.start_date}T00:00:00`).toISOString()
          : today.toISOString();
        const endDate = input.end_date
          ? new Date(`${input.end_date}T23:59:59`).toISOString()
          : new Date(today.getTime() + 86400000).toISOString();

        const accounts = input.account
          ? [input.account]
          : [config.outlook.email1, config.outlook.email2];

        const allEvents = [];
        for (const acct of accounts) {
          const events = await fetchOutlookCalendarEvents(acct, startDate, endDate);
          allEvents.push(...events);
        }

        if (allEvents.length === 0) return 'No events found in that date range.';

        return allEvents
          .sort((a, b) => a.startTime.localeCompare(b.startTime))
          .map((e) => `ID: ${e.id}\nAccount: ${e.calendarEmail}\nTitle: ${e.title}\nStart: ${e.startTime}\nEnd: ${e.endTime}\nLocation: ${e.location || '(none)'}\nAttendees: ${e.attendees.length > 0 ? e.attendees.join(', ') : '(none)'}`)
          .join('\n---\n');
      }

      case 'create_calendar_event': {
        const result = await createCalendarEvent(
          input.account,
          input.subject,
          input.start,
          input.end,
          {
            location: input.location,
            body: input.body,
            attendees: input.attendees,
            isOnline: input.is_online,
          },
        );
        return `Event created: "${result.subject}" (ID: ${result.id})`;
      }

      case 'update_calendar_event': {
        await updateCalendarEvent(input.account, input.event_id, {
          subject: input.subject,
          startDateTime: input.start,
          endDateTime: input.end,
          location: input.location,
        });
        return `Event updated successfully.`;
      }

      case 'delete_calendar_event': {
        await deleteCalendarEvent(input.account, input.event_id);
        return `Event deleted/cancelled.`;
      }

      // Schedule tools
      case 'update_schedule': {
        const result = updateScheduleAndRestart(getDb(), input.task_name, input.cron_expression, input.description);
        return result;
      }

      case 'toggle_schedule': {
        const result = toggleScheduledTask(getDb(), input.task_name, input.enabled);
        return result;
      }

      case 'view_schedule': {
        return getScheduleStatus(getDb());
      }

      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Tool error: ${msg}`;
  }
}
