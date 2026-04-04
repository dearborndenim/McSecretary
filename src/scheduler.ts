import cron, { type ScheduledTask as CronJob } from 'node-cron';
import { TIMEZONE } from './calendar/types.js';

export interface ScheduledTask {
  name: string;
  schedule: string;  // cron expression
  handler: () => Promise<void>;
  job?: CronJob;
}

export function startScheduler(tasks: ScheduledTask[]): void {
  for (const task of tasks) {
    console.log(`Scheduling "${task.name}" with cron: ${task.schedule}`);
    task.job = cron.schedule(task.schedule, async () => {
      console.log(`Running scheduled task: ${task.name}`);
      try {
        await task.handler();
        console.log(`Completed: ${task.name}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Failed: ${task.name} — ${msg}`);
      }
    }, { timezone: TIMEZONE });
  }
}

export function stopScheduler(tasks: ScheduledTask[]): void {
  for (const task of tasks) {
    task.job?.stop();
  }
}
