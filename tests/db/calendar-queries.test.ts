import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import { initializeCalendarSchema } from '../../src/db/calendar-schema.js';
import {
  upsertCalendarEvent,
  getEventsForDateRange,
  upsertWeeklyScheduleDay,
  getWeeklySchedule,
  insertPendingAction,
  getPendingActions,
  expirePendingActions,
  type CalendarEventRow,
} from '../../src/db/calendar-queries.js';

describe('calendar queries', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
    initializeCalendarSchema(db);
    // Seed a user for FK constraint
    db.prepare("INSERT INTO users (id, name, email, role) VALUES ('robert', 'Robert', 'rob@dd.com', 'admin')").run();
  });

  afterEach(() => {
    db.close();
  });

  describe('upsertCalendarEvent', () => {
    it('inserts a new event', () => {
      upsertCalendarEvent(db, {
        id: 'evt-1',
        source: 'outlook',
        calendar_email: 'rob@dearborndenim.com',
        title: 'Team standup',
        start_time: '2026-04-03T14:30:00Z',
        end_time: '2026-04-03T15:00:00Z',
        location: 'Teams',
        is_all_day: 0,
        status: 'confirmed',
        attendees: '["rob@dearborndenim.com","alice@example.com"]',
        user_id: 'robert',
      });

      const events = getEventsForDateRange(db, 'robert', '2026-04-03T00:00:00Z', '2026-04-04T00:00:00Z');
      expect(events).toHaveLength(1);
      expect(events[0]!.title).toBe('Team standup');
    });

    it('replaces on duplicate id', () => {
      upsertCalendarEvent(db, {
        id: 'evt-1', source: 'outlook', calendar_email: 'rob@dearborndenim.com',
        title: 'Original', start_time: '2026-04-03T14:30:00Z', end_time: '2026-04-03T15:00:00Z',
        location: '', is_all_day: 0, status: 'confirmed', attendees: '[]',
        user_id: 'robert',
      });
      upsertCalendarEvent(db, {
        id: 'evt-1', source: 'outlook', calendar_email: 'rob@dearborndenim.com',
        title: 'Updated', start_time: '2026-04-03T14:30:00Z', end_time: '2026-04-03T15:00:00Z',
        location: '', is_all_day: 0, status: 'confirmed', attendees: '[]',
        user_id: 'robert',
      });

      const events = getEventsForDateRange(db, 'robert', '2026-04-03T00:00:00Z', '2026-04-04T00:00:00Z');
      expect(events).toHaveLength(1);
      expect(events[0]!.title).toBe('Updated');
    });
  });

  describe('weekly schedule', () => {
    it('inserts and retrieves schedule for a week', () => {
      upsertWeeklyScheduleDay(db, 'robert', {
        week_start: '2026-03-30', day_of_week: 0,
        work_start: '06:00', work_end: '16:00', morning_routine: 'gym', notes: '',
      });
      upsertWeeklyScheduleDay(db, 'robert', {
        week_start: '2026-03-30', day_of_week: 1,
        work_start: '06:00', work_end: '16:00', morning_routine: 'bike', notes: 'Nice weather forecast',
      });

      const schedule = getWeeklySchedule(db, 'robert', '2026-03-30');
      expect(schedule).toHaveLength(2);
      expect(schedule[0]!.morning_routine).toBe('gym');
      expect(schedule[1]!.morning_routine).toBe('bike');
    });
  });

  describe('pending actions', () => {
    it('inserts and retrieves pending actions', () => {
      insertPendingAction(db, 'robert', {
        action_type: 'move_event', source_event_id: 'evt-1', source: 'outlook',
        calendar_email: 'rob@dearborndenim.com', description: 'Move dentist to 3:30 PM',
        proposed_data: '{"newStart":"2026-04-03T20:30:00Z"}', status: 'pending',
        expires_at: '2026-04-04T09:00:00Z',
      });

      const actions = getPendingActions(db, 'robert');
      expect(actions).toHaveLength(1);
      expect(actions[0]!.description).toBe('Move dentist to 3:30 PM');
    });

    it('expires old actions', () => {
      insertPendingAction(db, 'robert', {
        action_type: 'move_event', source_event_id: 'evt-1', source: 'outlook',
        calendar_email: 'rob@dearborndenim.com', description: 'Old action',
        proposed_data: '{}', status: 'pending', expires_at: '2026-04-01T00:00:00Z',
      });

      expirePendingActions(db, 'robert', '2026-04-03T00:00:00Z');
      const actions = getPendingActions(db, 'robert');
      expect(actions).toHaveLength(0);
    });
  });
});
