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
  // Calendar tools
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

      // Calendar tools
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
