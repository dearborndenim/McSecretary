import { describe, it, expect } from 'vitest';
import { detectConflicts } from '../../src/calendar/conflicts.js';
import type { UnifiedEvent, FreeSlot } from '../../src/calendar/types.js';

function makeEvent(overrides: Partial<UnifiedEvent>): UnifiedEvent {
  return {
    id: 'evt-1', source: 'outlook', calendarEmail: 'rob@dearborndenim.com',
    title: 'Meeting', startTime: '2026-04-03T14:00:00Z', endTime: '2026-04-03T15:00:00Z',
    location: '', isAllDay: false, status: 'confirmed', attendees: [],
    ...overrides,
  };
}

describe('detectConflicts', () => {
  const freeSlots: FreeSlot[] = [
    { start: '2026-04-03T17:00:00Z', end: '2026-04-03T19:00:00Z', durationMinutes: 120 },
  ];

  it('detects overlapping events', () => {
    const events = [
      makeEvent({ id: 'a', startTime: '2026-04-03T14:00:00Z', endTime: '2026-04-03T15:30:00Z' }),
      makeEvent({ id: 'b', startTime: '2026-04-03T15:00:00Z', endTime: '2026-04-03T16:00:00Z' }),
    ];
    const conflicts = detectConflicts(events, freeSlots);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.overlapMinutes).toBe(30);
  });

  it('returns no conflicts for non-overlapping events', () => {
    const events = [
      makeEvent({ id: 'a', startTime: '2026-04-03T14:00:00Z', endTime: '2026-04-03T15:00:00Z' }),
      makeEvent({ id: 'b', startTime: '2026-04-03T15:00:00Z', endTime: '2026-04-03T16:00:00Z' }),
    ];
    const conflicts = detectConflicts(events, freeSlots);
    expect(conflicts).toHaveLength(0);
  });

  it('proposes moving event with fewer attendees', () => {
    const events = [
      makeEvent({ id: 'a', title: 'Big team meeting', startTime: '2026-04-03T14:00:00Z', endTime: '2026-04-03T15:00:00Z', attendees: ['a@x.com', 'b@x.com', 'c@x.com'] }),
      makeEvent({ id: 'b', title: 'Quick 1:1', startTime: '2026-04-03T14:30:00Z', endTime: '2026-04-03T15:30:00Z', attendees: ['d@x.com'] }),
    ];
    const conflicts = detectConflicts(events, freeSlots);
    expect(conflicts[0]!.proposedMove!.eventToMove.id).toBe('b');
  });

  it('suggests no move when no free slot fits', () => {
    const events = [
      makeEvent({ id: 'a', startTime: '2026-04-03T14:00:00Z', endTime: '2026-04-03T15:00:00Z' }),
      makeEvent({ id: 'b', startTime: '2026-04-03T14:30:00Z', endTime: '2026-04-03T15:30:00Z' }),
    ];
    const noSlots: FreeSlot[] = [];
    const conflicts = detectConflicts(events, noSlots);
    expect(conflicts[0]!.proposedMove).toBeNull();
    expect(conflicts[0]!.suggestion).toContain('No available slot');
  });

  it('does not suggest moving events with 5+ attendees', () => {
    const events = [
      makeEvent({ id: 'a', startTime: '2026-04-03T14:00:00Z', endTime: '2026-04-03T15:00:00Z', attendees: ['1@x.com', '2@x.com', '3@x.com', '4@x.com', '5@x.com'] }),
      makeEvent({ id: 'b', startTime: '2026-04-03T14:30:00Z', endTime: '2026-04-03T15:30:00Z', attendees: ['6@x.com', '7@x.com', '8@x.com', '9@x.com', '10@x.com'] }),
    ];
    const conflicts = detectConflicts(events, freeSlots);
    expect(conflicts[0]!.proposedMove).toBeNull();
    expect(conflicts[0]!.suggestion).toContain('Both events have 5+ attendees');
  });
});
