import { describe, it, expect } from 'vitest';
import { mergeEvents } from '../../src/calendar/merger.js';
import type { UnifiedEvent } from '../../src/calendar/types.js';

function makeEvent(overrides: Partial<UnifiedEvent>): UnifiedEvent {
  return {
    id: 'evt-1',
    source: 'outlook',
    calendarEmail: 'rob@dearborndenim.com',
    title: 'Test Event',
    startTime: '2026-04-03T14:00:00Z',
    endTime: '2026-04-03T15:00:00Z',
    location: '',
    isAllDay: false,
    status: 'confirmed',
    attendees: [],
    ...overrides,
  };
}

describe('mergeEvents', () => {
  it('sorts events by start time', () => {
    const events = [
      makeEvent({ id: 'b', startTime: '2026-04-03T16:00:00Z' }),
      makeEvent({ id: 'a', startTime: '2026-04-03T14:00:00Z' }),
    ];
    const merged = mergeEvents(events);
    expect(merged[0]!.id).toBe('a');
    expect(merged[1]!.id).toBe('b');
  });

  it('deduplicates events with same title and start time across accounts', () => {
    const events = [
      makeEvent({ id: 'evt-1', calendarEmail: 'rob@dearborndenim.com', title: 'Joint Meeting', startTime: '2026-04-03T14:00:00Z' }),
      makeEvent({ id: 'evt-2', calendarEmail: 'robert@mcmillan-manufacturing.com', title: 'Joint Meeting', startTime: '2026-04-03T14:00:00Z' }),
    ];
    const merged = mergeEvents(events);
    expect(merged).toHaveLength(1);
  });

  it('keeps events with same title but different start times', () => {
    const events = [
      makeEvent({ id: 'evt-1', title: 'Standup', startTime: '2026-04-03T14:00:00Z' }),
      makeEvent({ id: 'evt-2', title: 'Standup', startTime: '2026-04-04T14:00:00Z' }),
    ];
    const merged = mergeEvents(events);
    expect(merged).toHaveLength(2);
  });

  it('excludes cancelled events', () => {
    const events = [
      makeEvent({ id: 'evt-1', status: 'confirmed' }),
      makeEvent({ id: 'evt-2', status: 'cancelled' }),
    ];
    const merged = mergeEvents(events);
    expect(merged).toHaveLength(1);
  });

  it('excludes all-day events', () => {
    const events = [
      makeEvent({ id: 'evt-1', isAllDay: false }),
      makeEvent({ id: 'evt-2', isAllDay: true }),
    ];
    const merged = mergeEvents(events);
    expect(merged).toHaveLength(1);
  });
});
