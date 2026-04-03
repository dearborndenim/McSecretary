import type { UnifiedEvent } from './types.js';

export function mergeEvents(events: UnifiedEvent[]): UnifiedEvent[] {
  const filtered = events.filter(
    (e) => e.status !== 'cancelled' && !e.isAllDay,
  );

  const seen = new Map<string, UnifiedEvent>();
  for (const event of filtered) {
    const key = `${event.title}|${event.startTime}`;
    if (!seen.has(key)) {
      seen.set(key, event);
    }
  }

  return Array.from(seen.values()).sort(
    (a, b) => a.startTime.localeCompare(b.startTime),
  );
}
