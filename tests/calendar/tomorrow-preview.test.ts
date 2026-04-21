import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import { createUser, addEmailAccount } from '../../src/db/user-queries.js';

// Mock outlook-calendar fetch so we never hit a real API
const mockFetchOutlookCalendarEvents = vi.fn();
vi.mock('../../src/calendar/outlook-calendar.js', () => ({
  fetchOutlookCalendarEvents: (...args: unknown[]) => mockFetchOutlookCalendarEvents(...args),
}));

import { getTomorrowEventsPreview } from '../../src/calendar/tomorrow-preview.js';

/**
 * Freeze time at 2026-04-16 18:00 UTC (= 2026-04-16 1 PM CT).
 * This puts "today in CT" at 2026-04-16 and "tomorrow in CT" at 2026-04-17,
 * matching the hard-coded event dates below. Without freezing, the suite
 * drifts across real midnight / DST / weekend boundaries and the "tomorrow"
 * filter silently drops every seeded event.
 *
 * IMPORTANT: both the outer describe's beforeEach AND each test that calls
 * getTomorrowEventsPreview without an explicit `now` param rely on this.
 */
const FROZEN_NOW = new Date('2026-04-16T18:00:00Z');

describe('getTomorrowEventsPreview', () => {
  let db: Database.Database;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_NOW);
    db = new Database(':memory:');
    initializeSchema(db);
    createUser(db, { id: 'u1', name: 'Robert', email: 'rob@dd.com', role: 'admin' });
    addEmailAccount(db, { id: 'ea1', user_id: 'u1', email_address: 'rob@dd.com', provider: 'outlook' });
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('returns formatted event list when tomorrow has events', async () => {
    mockFetchOutlookCalendarEvents.mockResolvedValue([
      {
        id: 'e1', source: 'outlook', calendarEmail: 'rob@dd.com',
        title: 'Production standup', startTime: '2026-04-17T13:00:00Z',
        endTime: '2026-04-17T14:00:00Z', location: 'Zoom',
        isAllDay: false, status: 'confirmed', attendees: [],
      },
      {
        id: 'e2', source: 'outlook', calendarEmail: 'rob@dd.com',
        title: 'Supplier call', startTime: '2026-04-17T19:00:00Z',
        endTime: '2026-04-17T20:00:00Z', location: '',
        isAllDay: false, status: 'confirmed', attendees: [],
      },
    ]);

    const preview = await getTomorrowEventsPreview(db, 'u1');
    expect(preview).toContain('Production standup');
    expect(preview).toContain('Supplier call');
  });

  it('returns "No events scheduled" when tomorrow has no events', async () => {
    mockFetchOutlookCalendarEvents.mockResolvedValue([]);
    const preview = await getTomorrowEventsPreview(db, 'u1');
    expect(preview.toLowerCase()).toContain('no events');
  });

  it('handles fetch errors gracefully (returns empty-style message)', async () => {
    mockFetchOutlookCalendarEvents.mockRejectedValue(new Error('graph error'));
    const preview = await getTomorrowEventsPreview(db, 'u1');
    // Should not throw. Return something reasonable.
    expect(typeof preview).toBe('string');
    expect(preview.length).toBeGreaterThan(0);
  });

  it('returns "No events scheduled" when user has no email accounts', async () => {
    createUser(db, { id: 'u2', name: 'No Accounts', email: 'noemail@dd.com', role: 'member' });
    const preview = await getTomorrowEventsPreview(db, 'u2');
    expect(preview.toLowerCase()).toContain('no events');
    expect(mockFetchOutlookCalendarEvents).not.toHaveBeenCalled();
  });
});

/**
 * Deterministic boundary scenarios. Each uses an explicit `now` argument
 * (instead of relying on the frozen system clock) to pin the exact edge
 * case being tested — midnight rollover, DST, Friday→Saturday, month-end,
 * year-end. These were the previously-flaky cases.
 */
describe('getTomorrowEventsPreview — boundary scenarios', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
    createUser(db, { id: 'u1', name: 'Robert', email: 'rob@dd.com', role: 'admin' });
    addEmailAccount(db, { id: 'ea1', user_id: 'u1', email_address: 'rob@dd.com', provider: 'outlook' });
    vi.clearAllMocks();
  });

  it('Friday evening CT correctly previews Saturday events', async () => {
    // 2026-04-17 Friday 9 PM CT -> tomorrow in CT is 2026-04-18 Saturday
    mockFetchOutlookCalendarEvents.mockResolvedValue([
      {
        id: 'e1', source: 'outlook', calendarEmail: 'rob@dd.com',
        title: 'Weekend planning', startTime: '2026-04-18T14:00:00Z',
        endTime: '2026-04-18T15:00:00Z', location: '',
        isAllDay: false, status: 'confirmed', attendees: [],
      },
    ]);
    const friday9pmCt = new Date('2026-04-18T02:00:00Z'); // Fri 9 PM CT
    const preview = await getTomorrowEventsPreview(db, 'u1', friday9pmCt);
    expect(preview).toContain('Weekend planning');
  });

  it('late-night CT (11 PM) does not leak today into tomorrow', async () => {
    // 2026-04-16 Thu 11 PM CT is still "today=Thu" in CT, "tomorrow=Fri"
    mockFetchOutlookCalendarEvents.mockResolvedValue([
      {
        id: 'today-evt', source: 'outlook', calendarEmail: 'rob@dd.com',
        title: 'Late today evt', startTime: '2026-04-17T03:30:00Z', // Thu 10:30 PM CT
        endTime: '2026-04-17T04:00:00Z', location: '',
        isAllDay: false, status: 'confirmed', attendees: [],
      },
      {
        id: 'tomorrow-evt', source: 'outlook', calendarEmail: 'rob@dd.com',
        title: 'Friday morning', startTime: '2026-04-17T14:00:00Z',
        endTime: '2026-04-17T15:00:00Z', location: '',
        isAllDay: false, status: 'confirmed', attendees: [],
      },
    ]);
    const thu11pmCt = new Date('2026-04-17T04:00:00Z');
    const preview = await getTomorrowEventsPreview(db, 'u1', thu11pmCt);
    expect(preview).toContain('Friday morning');
    // The event at 10:30 PM CT on Thursday is "today" (Thu), not "tomorrow".
    expect(preview).not.toContain('Late today evt');
  });

  it('month boundary: 2026-04-30 -> 2026-05-01 renders next-month events', async () => {
    mockFetchOutlookCalendarEvents.mockResolvedValue([
      {
        id: 'e1', source: 'outlook', calendarEmail: 'rob@dd.com',
        title: 'May Day kickoff', startTime: '2026-05-01T14:00:00Z',
        endTime: '2026-05-01T15:00:00Z', location: '',
        isAllDay: false, status: 'confirmed', attendees: [],
      },
    ]);
    // 2026-04-30 12 PM CT
    const apr30 = new Date('2026-04-30T17:00:00Z');
    const preview = await getTomorrowEventsPreview(db, 'u1', apr30);
    expect(preview).toContain('May Day kickoff');
  });

  it('year boundary: 2026-12-31 -> 2027-01-01 renders new-year events', async () => {
    mockFetchOutlookCalendarEvents.mockResolvedValue([
      {
        id: 'e1', source: 'outlook', calendarEmail: 'rob@dd.com',
        title: 'New Year breakfast', startTime: '2027-01-01T15:00:00Z',
        endTime: '2027-01-01T16:00:00Z', location: '',
        isAllDay: false, status: 'confirmed', attendees: [],
      },
    ]);
    const dec31 = new Date('2026-12-31T18:00:00Z'); // noon CT
    const preview = await getTomorrowEventsPreview(db, 'u1', dec31);
    expect(preview).toContain('New Year breakfast');
  });

  it('DST spring-forward (2026-03-07 -> 2026-03-08): tomorrow still resolves correctly', async () => {
    // CT goes from CST (-06:00) to CDT (-05:00) on Sun 2026-03-08 02:00 local
    mockFetchOutlookCalendarEvents.mockResolvedValue([
      {
        id: 'e1', source: 'outlook', calendarEmail: 'rob@dd.com',
        title: 'DST brunch', startTime: '2026-03-08T15:00:00Z', // 10 AM CDT
        endTime: '2026-03-08T16:00:00Z', location: '',
        isAllDay: false, status: 'confirmed', attendees: [],
      },
    ]);
    const mar7Evening = new Date('2026-03-08T02:00:00Z'); // Sat 8 PM CST
    const preview = await getTomorrowEventsPreview(db, 'u1', mar7Evening);
    expect(preview).toContain('DST brunch');
  });
});
