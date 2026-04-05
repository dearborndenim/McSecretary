/**
 * Tool definitions for Claude's tool_use feature.
 * These give the AI secretary the ability to execute real actions.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { archiveOutlookEmail, markOutlookAsRead, categorizeOutlookEmail } from './email/actions.js';
import {
  getFormattedTaskLists,
  findOrCreateTaskList,
  createTask,
  completeTask,
  getIncompleteTasks,
} from './tasks/todo.js';

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

      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Tool error: ${msg}`;
  }
}
