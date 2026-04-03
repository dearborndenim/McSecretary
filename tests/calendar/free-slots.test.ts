import { describe, it, expect } from 'vitest';
import { findFreeSlots } from '../../src/calendar/free-slots.js';
import type { UnifiedEvent } from '../../src/calendar/types.js';

function makeEvent(start: string, end: string): UnifiedEvent {
  return {
    id: 'evt',
    source: 'outlook',
    calendarEmail: 'rob@dearborndenim.com',
    title: 'Busy',
    startTime: start,
    endTime: end,
    location: '',
    isAllDay: false,
    status: 'confirmed',
    attendees: [],
  };
}

describe('findFreeSlots', () => {
  const dayStart = '2026-04-03T11:00:00Z';
  const dayEnd = '2026-04-03T21:00:00Z';

  it('returns full day when no events', () => {
    const slots = findFreeSlots([], dayStart, dayEnd);
    expect(slots).toHaveLength(1);
    expect(slots[0]!.start).toBe(dayStart);
    expect(slots[0]!.end).toBe(dayEnd);
    expect(slots[0]!.durationMinutes).toBe(600);
  });

  it('finds gaps between events', () => {
    const events = [
      makeEvent('2026-04-03T14:00:00Z', '2026-04-03T15:00:00Z'),
      makeEvent('2026-04-03T18:00:00Z', '2026-04-03T19:00:00Z'),
    ];
    const slots = findFreeSlots(events, dayStart, dayEnd);
    expect(slots).toHaveLength(3);
    expect(slots[0]!.start).toBe('2026-04-03T11:00:00Z');
    expect(slots[0]!.end).toBe('2026-04-03T14:00:00Z');
    expect(slots[0]!.durationMinutes).toBe(180);
    expect(slots[1]!.start).toBe('2026-04-03T15:00:00Z');
    expect(slots[1]!.end).toBe('2026-04-03T18:00:00Z');
    expect(slots[2]!.start).toBe('2026-04-03T19:00:00Z');
    expect(slots[2]!.end).toBe('2026-04-03T21:00:00Z');
  });

  it('handles back-to-back events with no gap', () => {
    const events = [
      makeEvent('2026-04-03T14:00:00Z', '2026-04-03T15:00:00Z'),
      makeEvent('2026-04-03T15:00:00Z', '2026-04-03T16:00:00Z'),
    ];
    const slots = findFreeSlots(events, dayStart, dayEnd);
    expect(slots).toHaveLength(2);
  });

  it('handles event spanning entire work day', () => {
    const events = [
      makeEvent('2026-04-03T11:00:00Z', '2026-04-03T21:00:00Z'),
    ];
    const slots = findFreeSlots(events, dayStart, dayEnd);
    expect(slots).toHaveLength(0);
  });

  it('handles overlapping events correctly', () => {
    const events = [
      makeEvent('2026-04-03T14:00:00Z', '2026-04-03T16:00:00Z'),
      makeEvent('2026-04-03T15:00:00Z', '2026-04-03T17:00:00Z'),
    ];
    const slots = findFreeSlots(events, dayStart, dayEnd);
    expect(slots).toHaveLength(2);
    expect(slots[0]!.end).toBe('2026-04-03T14:00:00Z');
    expect(slots[1]!.start).toBe('2026-04-03T17:00:00Z');
  });
});
