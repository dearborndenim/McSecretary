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

describe('getTomorrowEventsPreview', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
    createUser(db, { id: 'u1', name: 'Robert', email: 'rob@dd.com', role: 'admin' });
    addEmailAccount(db, { id: 'ea1', user_id: 'u1', email_address: 'rob@dd.com', provider: 'outlook' });
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
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
