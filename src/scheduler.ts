import cron, { type ScheduledTask as CronJob } from 'node-cron';
import type Database from 'better-sqlite3';
import { TIMEZONE } from './calendar/types.js';
import {
  upsertScheduledTask,
  getEnabledScheduledTasks,
  getScheduledTasks,
  enableScheduledTask as enableScheduledTaskDb,
  disableScheduledTask as disableScheduledTaskDb,
  type ScheduledTaskRow,
} from './db/schedule-queries.js';

export interface ScheduledTask {
  name: string;
  schedule: string;
  handler: () => Promise<void>;
  description?: string;
}

// Active cron jobs keyed by name
const activeJobs = new Map<string, CronJob>();

// Registered handlers keyed by name
const handlers = new Map<string, () => Promise<void>>();

export function registerHandler(name: string, handler: () => Promise<void>): void {
  handlers.set(name, handler);
}

export function initializeDefaultSchedule(db: Database.Database, defaults: ScheduledTask[]): void {
  const existing = getScheduledTasks(db);
  const existingNames = new Set(existing.map((t) => t.name));

  for (const task of defaults) {
    if (!existingNames.has(task.name)) {
      upsertScheduledTask(db, task.name, task.schedule, task.description ?? '', true);
    }
    registerHandler(task.name, task.handler);
  }
}

export function startSchedulerFromDb(db: Database.Database): void {
  // Stop any existing jobs
  stopAllJobs();

  const tasks = getEnabledScheduledTasks(db);

  for (const task of tasks) {
    const handler = handlers.get(task.name);
    if (!handler) {
      console.warn(`No handler registered for scheduled task: ${task.name}`);
      continue;
    }

    console.log(`Scheduling "${task.name}" with cron: ${task.cron_expression}`);
    const job = cron.schedule(task.cron_expression, async () => {
      console.log(`Running scheduled task: ${task.name}`);
      try {
        await handler();
        console.log(`Completed: ${task.name}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Failed: ${task.name} — ${msg}`);
      }
    }, { timezone: TIMEZONE });

    activeJobs.set(task.name, job);
  }
}

export function stopAllJobs(): void {
  for (const [name, job] of activeJobs) {
    job.stop();
  }
  activeJobs.clear();
}

// Called by the tool to update a schedule at runtime
export function updateScheduleAndRestart(
  db: Database.Database,
  name: string,
  cronExpression: string,
  description?: string,
): string {
  if (!cron.validate(cronExpression)) {
    return `Invalid cron expression: "${cronExpression}"`;
  }

  if (!handlers.has(name)) {
    return `Unknown task name: "${name}". Known tasks: ${Array.from(handlers.keys()).join(', ')}`;
  }

  upsertScheduledTask(db, name, cronExpression, description ?? '');

  // Restart just this job
  const existingJob = activeJobs.get(name);
  if (existingJob) {
    existingJob.stop();
    activeJobs.delete(name);
  }

  const handler = handlers.get(name)!;
  console.log(`Rescheduling "${name}" to: ${cronExpression}`);
  const job = cron.schedule(cronExpression, async () => {
    console.log(`Running scheduled task: ${name}`);
    try {
      await handler();
      console.log(`Completed: ${name}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Failed: ${name} — ${msg}`);
    }
  }, { timezone: TIMEZONE });

  activeJobs.set(name, job);
  return `Schedule updated: "${name}" now runs at "${cronExpression}"`;
}

export function toggleScheduledTask(
  db: Database.Database,
  name: string,
  enabled: boolean,
): string {
  if (!handlers.has(name)) {
    return `Unknown task: "${name}"`;
  }

  if (enabled) {
    enableScheduledTaskDb(db, name);
    startSchedulerFromDb(db);
    return `Enabled: "${name}"`;
  } else {
    disableScheduledTaskDb(db, name);
    const job = activeJobs.get(name);
    if (job) {
      job.stop();
      activeJobs.delete(name);
    }
    return `Disabled: "${name}"`;
  }
}

export function getScheduleStatus(db: Database.Database): string {
  const tasks = getScheduledTasks(db);
  if (tasks.length === 0) return 'No scheduled tasks configured.';

  return tasks.map((t) => {
    const status = t.enabled ? 'ACTIVE' : 'DISABLED';
    const running = activeJobs.has(t.name) ? ' (running)' : '';
    return `- ${t.name}: ${t.cron_expression} [${status}]${running}${t.description ? ` — ${t.description}` : ''}`;
  }).join('\n');
}
