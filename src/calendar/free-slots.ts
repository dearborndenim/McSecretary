import type { UnifiedEvent, FreeSlot } from './types.js';

export function findFreeSlots(
  events: UnifiedEvent[],
  dayStart: string,
  dayEnd: string,
): FreeSlot[] {
  const sorted = [...events].sort((a, b) => a.startTime.localeCompare(b.startTime));

  const slots: FreeSlot[] = [];
  let current = dayStart;

  for (const event of sorted) {
    if (event.startTime > current) {
      const durationMinutes = minutesBetween(current, event.startTime);
      if (durationMinutes > 0) {
        slots.push({ start: current, end: event.startTime, durationMinutes });
      }
    }
    if (event.endTime > current) {
      current = event.endTime;
    }
  }

  if (current < dayEnd) {
    const durationMinutes = minutesBetween(current, dayEnd);
    if (durationMinutes > 0) {
      slots.push({ start: current, end: dayEnd, durationMinutes });
    }
  }

  return slots;
}

function minutesBetween(a: string, b: string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000);
}
