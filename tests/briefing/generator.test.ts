import { describe, it, expect } from 'vitest';
import { buildBriefingPrompt } from '../../src/briefing/generator.js';
import type { ClassifiedEmail } from '../../src/email/types.js';
import type { ConflictResult } from '../../src/calendar/types.js';

function makeClassified(overrides: Partial<ClassifiedEmail>): ClassifiedEmail {
  return {
    id: 'msg-1',
    account: 'rob@dearborndenim.com',
    sender: 'test@example.com',
    senderName: 'Test',
    subject: 'Test Subject',
    bodyPreview: 'Test body',
    body: 'Test body content',
    receivedAt: '2026-04-03T05:00:00Z',
    threadId: 'thread-1',
    isRead: false,
    category: 'customer_inquiry',
    urgency: 'high',
    actionNeeded: 'reply_required',
    confidence: 0.95,
    summary: 'Customer asking about bulk order',
    suggestedAction: 'Draft reply with pricing',
    senderImportance: 'new_customer',
    ...overrides,
  };
}

describe('buildBriefingPrompt', () => {
  it('groups emails by urgency in the prompt', () => {
    const emails = [
      makeClassified({ id: '1', urgency: 'critical', summary: 'Urgent customer issue' }),
      makeClassified({ id: '2', urgency: 'low', category: 'newsletter', summary: 'Industry news' }),
      makeClassified({ id: '3', urgency: 'high', summary: 'Supplier pricing update' }),
    ];

    const prompt = buildBriefingPrompt(emails, {
      totalProcessed: 50,
      archived: 30,
      flaggedForReview: 20,
    });

    expect(prompt).toContain('Urgent customer issue');
    expect(prompt).toContain('Supplier pricing update');
    expect(prompt).toContain('50');
  });

  it('includes stats in the prompt', () => {
    const prompt = buildBriefingPrompt([], {
      totalProcessed: 10,
      archived: 8,
      flaggedForReview: 2,
    });

    expect(prompt).toContain('10');
    expect(prompt).toContain('8');
  });
});

describe('buildBriefingPrompt with calendar', () => {
  it('includes calendar events in the prompt', () => {
    const calendarData = {
      events: [
        {
          id: 'evt-1', source: 'outlook' as const, calendarEmail: 'rob@dearborndenim.com',
          title: 'Team standup', startTime: '2026-04-03T14:30:00Z', endTime: '2026-04-03T15:00:00Z',
          location: 'Teams', isAllDay: false, status: 'confirmed' as const, attendees: [],
        },
      ],
      conflicts: [],
      freeSlots: [
        { start: '2026-04-03T11:00:00Z', end: '2026-04-03T14:30:00Z', durationMinutes: 210 },
      ],
      pendingActions: [],
    };

    const prompt = buildBriefingPrompt([], { totalProcessed: 0, archived: 0, flaggedForReview: 0 }, calendarData);
    expect(prompt).toContain('Team standup');
    expect(prompt).toContain('TODAY\'S SCHEDULE');
  });

  it('includes conflicts in the prompt', () => {
    const conflict: ConflictResult = {
      eventA: {
        id: 'a', source: 'outlook', calendarEmail: 'rob@dearborndenim.com',
        title: 'Supplier call', startTime: '2026-04-03T16:00:00Z', endTime: '2026-04-03T17:00:00Z',
        location: '', isAllDay: false, status: 'confirmed', attendees: [],
      },
      eventB: {
        id: 'b', source: 'outlook', calendarEmail: 'rob@dearborndenim.com',
        title: 'Dentist', startTime: '2026-04-03T16:30:00Z', endTime: '2026-04-03T17:30:00Z',
        location: '', isAllDay: false, status: 'confirmed', attendees: [],
      },
      overlapMinutes: 30,
      suggestion: 'Move "Dentist" to 2:00 PM',
      proposedMove: null,
    };

    const calendarData = { events: [], conflicts: [conflict], freeSlots: [], pendingActions: [] };
    const prompt = buildBriefingPrompt([], { totalProcessed: 0, archived: 0, flaggedForReview: 0 }, calendarData);
    expect(prompt).toContain('CONFLICTS');
    expect(prompt).toContain('Supplier call');
    expect(prompt).toContain('Dentist');
  });

  it('works without calendar data (backwards compatible)', () => {
    const prompt = buildBriefingPrompt([], { totalProcessed: 5, archived: 3, flaggedForReview: 2 });
    expect(prompt).toContain('5');
    expect(prompt).not.toContain('SCHEDULE');
  });
});
