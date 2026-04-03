# Phase 2: Calendar Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Outlook Calendar fetching, conflict detection, free slot finding, and calendar-aware morning briefings to the McSecretary overnight triage pipeline.

**Architecture:** New `calendar/` module fetches events from both Outlook accounts via Graph API, merges into unified timeline (America/Chicago), detects conflicts, proposes resolutions using weekly schedule preferences, and feeds calendar data into the existing briefing generator. Three new SQLite tables store event cache, weekly schedule, and pending actions.

**Tech Stack:** TypeScript (strict), Microsoft Graph Calendar API, better-sqlite3, existing Anthropic SDK for briefing

**Spec:** `docs/superpowers/specs/2026-04-03-phase2-calendar-unification-design.md`

---

## File Structure

```
src/
├── calendar/
│   ├── types.ts              # UnifiedEvent, ConflictResult, FreeSlot, WeeklyScheduleDay, PendingAction
│   ├── outlook-calendar.ts   # Fetch events from Outlook Calendar via Graph API
│   ├── merger.ts             # Merge events, normalize to Chicago time, sort, deduplicate
│   ├── conflicts.ts          # Detect overlaps, propose resolutions
│   └── free-slots.ts         # Find available blocks within work hours
├── db/
│   ├── calendar-schema.ts    # CREATE TABLE for 3 new tables
│   └── calendar-queries.ts   # Typed CRUD for calendar tables
├── briefing/
│   └── generator.ts          # MODIFIED: add calendar section to prompt
├── db/
│   └── schema.ts             # MODIFIED: call calendar schema init
└── index.ts                  # MODIFIED: add calendar pipeline step

tests/
├── calendar/
│   ├── merger.test.ts
│   ├── conflicts.test.ts
│   └── free-slots.test.ts
└── db/
    └── calendar-queries.test.ts
```

---

## Task 1: Calendar Types

**Files:**
- Create: `src/calendar/types.ts`

- [ ] **Step 1: Create types.ts**

```typescript
export interface UnifiedEvent {
  id: string;
  source: 'outlook' | 'google' | 'apple';
  calendarEmail: string;
  title: string;
  startTime: string;  // ISO 8601 UTC
  endTime: string;    // ISO 8601 UTC
  location: string;
  isAllDay: boolean;
  status: 'confirmed' | 'tentative' | 'cancelled';
  attendees: string[];
}

export interface ConflictResult {
  eventA: UnifiedEvent;
  eventB: UnifiedEvent;
  overlapMinutes: number;
  suggestion: string | null;
  proposedMove: ProposedMove | null;
}

export interface ProposedMove {
  eventToMove: UnifiedEvent;
  newStartTime: string;
  newEndTime: string;
  reason: string;
}

export interface FreeSlot {
  start: string;  // ISO 8601 UTC
  end: string;    // ISO 8601 UTC
  durationMinutes: number;
}

export interface WeeklyScheduleDay {
  weekStart: string;   // YYYY-MM-DD (Monday)
  dayOfWeek: number;   // 0=Monday, 6=Sunday
  workStart: string;   // HH:MM, default "06:00"
  workEnd: string;     // HH:MM, default "16:00"
  morningRoutine: 'bike' | 'gym' | 'default';
  notes: string;
}

export interface PendingAction {
  id?: number;
  createdAt?: string;
  actionType: 'move_event' | 'cancel_event' | 'create_event';
  sourceEventId: string;
  source: string;
  calendarEmail: string;
  description: string;
  proposedData: string;  // JSON
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  expiresAt: string;
}

export const TIMEZONE = 'America/Chicago';

export const DEFAULT_WORK_START = '06:00';
export const DEFAULT_WORK_END = '16:00';

// Re-exported in briefing generator, but canonical definition lives here
export interface CalendarBriefingData {
  events: UnifiedEvent[];
  conflicts: ConflictResult[];
  freeSlots: FreeSlot[];
  pendingActions: { description: string }[];
}
```

- [ ] **Step 2: Commit**

```bash
git add src/calendar/types.ts
git commit -m "feat(calendar): add calendar type definitions"
```

---

## Task 2: Calendar Database Schema + Queries

**Files:**
- Create: `src/db/calendar-schema.ts`
- Create: `src/db/calendar-queries.ts`
- Create: `tests/db/calendar-queries.test.ts`
- Modify: `src/db/schema.ts`

- [ ] **Step 1: Write tests/db/calendar-queries.test.ts**

```typescript
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
      });

      const events = getEventsForDateRange(db, '2026-04-03T00:00:00Z', '2026-04-04T00:00:00Z');
      expect(events).toHaveLength(1);
      expect(events[0]!.title).toBe('Team standup');
    });

    it('replaces on duplicate id', () => {
      upsertCalendarEvent(db, {
        id: 'evt-1',
        source: 'outlook',
        calendar_email: 'rob@dearborndenim.com',
        title: 'Original',
        start_time: '2026-04-03T14:30:00Z',
        end_time: '2026-04-03T15:00:00Z',
        location: '',
        is_all_day: 0,
        status: 'confirmed',
        attendees: '[]',
      });
      upsertCalendarEvent(db, {
        id: 'evt-1',
        source: 'outlook',
        calendar_email: 'rob@dearborndenim.com',
        title: 'Updated',
        start_time: '2026-04-03T14:30:00Z',
        end_time: '2026-04-03T15:00:00Z',
        location: '',
        is_all_day: 0,
        status: 'confirmed',
        attendees: '[]',
      });

      const events = getEventsForDateRange(db, '2026-04-03T00:00:00Z', '2026-04-04T00:00:00Z');
      expect(events).toHaveLength(1);
      expect(events[0]!.title).toBe('Updated');
    });
  });

  describe('weekly schedule', () => {
    it('inserts and retrieves schedule for a week', () => {
      upsertWeeklyScheduleDay(db, {
        week_start: '2026-03-30',
        day_of_week: 0,
        work_start: '06:00',
        work_end: '16:00',
        morning_routine: 'gym',
        notes: '',
      });
      upsertWeeklyScheduleDay(db, {
        week_start: '2026-03-30',
        day_of_week: 1,
        work_start: '06:00',
        work_end: '16:00',
        morning_routine: 'bike',
        notes: 'Nice weather forecast',
      });

      const schedule = getWeeklySchedule(db, '2026-03-30');
      expect(schedule).toHaveLength(2);
      expect(schedule[0]!.morning_routine).toBe('gym');
      expect(schedule[1]!.morning_routine).toBe('bike');
    });
  });

  describe('pending actions', () => {
    it('inserts and retrieves pending actions', () => {
      insertPendingAction(db, {
        action_type: 'move_event',
        source_event_id: 'evt-1',
        source: 'outlook',
        calendar_email: 'rob@dearborndenim.com',
        description: 'Move dentist to 3:30 PM',
        proposed_data: '{"newStart":"2026-04-03T20:30:00Z","newEnd":"2026-04-03T21:30:00Z"}',
        status: 'pending',
        expires_at: '2026-04-04T09:00:00Z',
      });

      const actions = getPendingActions(db);
      expect(actions).toHaveLength(1);
      expect(actions[0]!.description).toBe('Move dentist to 3:30 PM');
    });

    it('expires old actions', () => {
      insertPendingAction(db, {
        action_type: 'move_event',
        source_event_id: 'evt-1',
        source: 'outlook',
        calendar_email: 'rob@dearborndenim.com',
        description: 'Old action',
        proposed_data: '{}',
        status: 'pending',
        expires_at: '2026-04-01T00:00:00Z',
      });

      expirePendingActions(db, '2026-04-03T00:00:00Z');

      const actions = getPendingActions(db);
      expect(actions).toHaveLength(0);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/db/calendar-queries.test.ts
```

Expected: FAIL — modules not found.

- [ ] **Step 3: Implement src/db/calendar-schema.ts**

```typescript
import type Database from 'better-sqlite3';

export function initializeCalendarSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS calendar_events (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      calendar_email TEXT NOT NULL,
      title TEXT,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      location TEXT DEFAULT '',
      is_all_day INTEGER DEFAULT 0,
      status TEXT DEFAULT 'confirmed',
      attendees TEXT DEFAULT '[]',
      fetched_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS weekly_schedule (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      week_start TEXT NOT NULL,
      day_of_week INTEGER NOT NULL,
      work_start TEXT DEFAULT '06:00',
      work_end TEXT DEFAULT '16:00',
      morning_routine TEXT DEFAULT 'default',
      notes TEXT DEFAULT '',
      UNIQUE(week_start, day_of_week)
    );

    CREATE TABLE IF NOT EXISTS pending_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT DEFAULT (datetime('now')),
      action_type TEXT NOT NULL,
      source_event_id TEXT NOT NULL,
      source TEXT NOT NULL,
      calendar_email TEXT NOT NULL,
      description TEXT NOT NULL,
      proposed_data TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      expires_at TEXT NOT NULL
    );
  `);
}
```

- [ ] **Step 4: Implement src/db/calendar-queries.ts**

```typescript
import type Database from 'better-sqlite3';

export interface CalendarEventRow {
  id: string;
  source: string;
  calendar_email: string;
  title: string;
  start_time: string;
  end_time: string;
  location: string;
  is_all_day: number;
  status: string;
  attendees: string;
  fetched_at: string;
}

export interface WeeklyScheduleRow {
  id: number;
  week_start: string;
  day_of_week: number;
  work_start: string;
  work_end: string;
  morning_routine: string;
  notes: string;
}

export interface PendingActionRow {
  id: number;
  created_at: string;
  action_type: string;
  source_event_id: string;
  source: string;
  calendar_email: string;
  description: string;
  proposed_data: string;
  status: string;
  expires_at: string;
}

export function upsertCalendarEvent(
  db: Database.Database,
  event: Omit<CalendarEventRow, 'fetched_at'>,
): void {
  db.prepare(`
    INSERT OR REPLACE INTO calendar_events
    (id, source, calendar_email, title, start_time, end_time, location, is_all_day, status, attendees)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.id, event.source, event.calendar_email, event.title,
    event.start_time, event.end_time, event.location,
    event.is_all_day, event.status, event.attendees
  );
}

export function getEventsForDateRange(
  db: Database.Database,
  startUtc: string,
  endUtc: string,
): CalendarEventRow[] {
  return db.prepare(`
    SELECT * FROM calendar_events
    WHERE start_time >= ? AND start_time < ?
    AND status != 'cancelled'
    ORDER BY start_time ASC
  `).all(startUtc, endUtc) as CalendarEventRow[];
}

export function upsertWeeklyScheduleDay(
  db: Database.Database,
  day: Omit<WeeklyScheduleRow, 'id'>,
): void {
  db.prepare(`
    INSERT OR REPLACE INTO weekly_schedule
    (week_start, day_of_week, work_start, work_end, morning_routine, notes)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    day.week_start, day.day_of_week, day.work_start,
    day.work_end, day.morning_routine, day.notes
  );
}

export function getWeeklySchedule(
  db: Database.Database,
  weekStart: string,
): WeeklyScheduleRow[] {
  return db.prepare(`
    SELECT * FROM weekly_schedule
    WHERE week_start = ?
    ORDER BY day_of_week ASC
  `).all(weekStart) as WeeklyScheduleRow[];
}

export function insertPendingAction(
  db: Database.Database,
  action: Omit<PendingActionRow, 'id' | 'created_at'>,
): number {
  const result = db.prepare(`
    INSERT INTO pending_actions
    (action_type, source_event_id, source, calendar_email, description, proposed_data, status, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    action.action_type, action.source_event_id, action.source,
    action.calendar_email, action.description, action.proposed_data,
    action.status, action.expires_at
  );
  return Number(result.lastInsertRowid);
}

export function getPendingActions(db: Database.Database): PendingActionRow[] {
  return db.prepare(`
    SELECT * FROM pending_actions
    WHERE status = 'pending'
    ORDER BY created_at ASC
  `).all() as PendingActionRow[];
}

export function expirePendingActions(db: Database.Database, now: string): void {
  db.prepare(`
    UPDATE pending_actions
    SET status = 'expired'
    WHERE status = 'pending' AND expires_at < ?
  `).run(now);
}
```

- [ ] **Step 5: Modify src/db/schema.ts to call calendar schema**

Add import and call at the end of `initializeSchema`:

```typescript
import type Database from 'better-sqlite3';
import { initializeCalendarSchema } from './calendar-schema.js';

export function initializeSchema(db: Database.Database): void {
  db.exec(`
    // ... existing tables unchanged ...
  `);

  initializeCalendarSchema(db);
}
```

- [ ] **Step 6: Run tests**

```bash
npx vitest run tests/db/
```

Expected: All pass (both existing schema/queries tests and new calendar-queries tests).

- [ ] **Step 7: Commit**

```bash
git add src/db/calendar-schema.ts src/db/calendar-queries.ts src/db/schema.ts tests/db/calendar-queries.test.ts
git commit -m "feat(calendar): add calendar database schema and queries"
```

---

## Task 3: Outlook Calendar Fetcher

**Files:**
- Create: `src/calendar/outlook-calendar.ts`

- [ ] **Step 1: Implement outlook-calendar.ts**

```typescript
import type { UnifiedEvent } from './types.js';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

interface GraphCalendarEvent {
  id: string;
  subject: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  location: { displayName: string };
  isAllDay: boolean;
  showAs: string;
  isCancelled: boolean;
  responseStatus: { response: string };
  attendees: { emailAddress: { address: string } }[];
}

interface GraphCalendarResponse {
  value: GraphCalendarEvent[];
}

export async function fetchOutlookCalendarEvents(
  userEmail: string,
  startDate: string,
  endDate: string,
): Promise<UnifiedEvent[]> {
  const { getGraphToken } = await import('../auth/graph.js');
  const token = await getGraphToken();

  const url = `${GRAPH_BASE}/users/${userEmail}/calendarview?startDateTime=${startDate}&endDateTime=${endDate}&$top=100&$select=id,subject,start,end,location,isAllDay,showAs,isCancelled,responseStatus,attendees`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Prefer: 'outlook.timezone="UTC"',
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Graph Calendar API error (${response.status}): ${text}`);
  }

  const data = (await response.json()) as GraphCalendarResponse;

  return data.value
    .filter((evt) => !evt.isCancelled && evt.responseStatus.response !== 'declined')
    .map((evt): UnifiedEvent => ({
      id: evt.id,
      source: 'outlook',
      calendarEmail: userEmail,
      title: evt.subject,
      startTime: evt.start.dateTime.endsWith('Z') ? evt.start.dateTime : evt.start.dateTime + 'Z',
      endTime: evt.end.dateTime.endsWith('Z') ? evt.end.dateTime : evt.end.dateTime + 'Z',
      location: evt.location?.displayName ?? '',
      isAllDay: evt.isAllDay,
      status: evt.showAs === 'tentative' ? 'tentative' : 'confirmed',
      attendees: evt.attendees?.map((a) => a.emailAddress.address) ?? [],
    }));
}
```

- [ ] **Step 2: Commit**

```bash
git add src/calendar/outlook-calendar.ts
git commit -m "feat(calendar): add Outlook Calendar event fetcher via Graph API"
```

---

## Task 4: Event Merger

**Files:**
- Create: `src/calendar/merger.ts`
- Create: `tests/calendar/merger.test.ts`

- [ ] **Step 1: Write tests/calendar/merger.test.ts**

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/calendar/merger.test.ts
```

- [ ] **Step 3: Implement src/calendar/merger.ts**

```typescript
import type { UnifiedEvent } from './types.js';

export function mergeEvents(events: UnifiedEvent[]): UnifiedEvent[] {
  // Filter out cancelled and all-day events
  const filtered = events.filter(
    (e) => e.status !== 'cancelled' && !e.isAllDay,
  );

  // Deduplicate: same title + same start time = same event on multiple calendars
  const seen = new Map<string, UnifiedEvent>();
  for (const event of filtered) {
    const key = `${event.title}|${event.startTime}`;
    if (!seen.has(key)) {
      seen.set(key, event);
    }
  }

  // Sort by start time
  return Array.from(seen.values()).sort(
    (a, b) => a.startTime.localeCompare(b.startTime),
  );
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/calendar/merger.test.ts
```

Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add src/calendar/merger.ts tests/calendar/merger.test.ts
git commit -m "feat(calendar): add event merger with dedup and sort"
```

---

## Task 5: Free Slot Finder

**Files:**
- Create: `src/calendar/free-slots.ts`
- Create: `tests/calendar/free-slots.test.ts`

- [ ] **Step 1: Write tests/calendar/free-slots.test.ts**

```typescript
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
  // Work day: 6 AM - 4 PM Chicago = 11:00-21:00 UTC (CDT, UTC-5)
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
      makeEvent('2026-04-03T14:00:00Z', '2026-04-03T15:00:00Z'), // 9-10 AM Chicago
      makeEvent('2026-04-03T18:00:00Z', '2026-04-03T19:00:00Z'), // 1-2 PM Chicago
    ];

    const slots = findFreeSlots(events, dayStart, dayEnd);
    expect(slots).toHaveLength(3);
    // Before first event: 11:00-14:00 (3 hours)
    expect(slots[0]!.start).toBe('2026-04-03T11:00:00Z');
    expect(slots[0]!.end).toBe('2026-04-03T14:00:00Z');
    expect(slots[0]!.durationMinutes).toBe(180);
    // Between events: 15:00-18:00 (3 hours)
    expect(slots[1]!.start).toBe('2026-04-03T15:00:00Z');
    expect(slots[1]!.end).toBe('2026-04-03T18:00:00Z');
    // After last event: 19:00-21:00 (2 hours)
    expect(slots[2]!.start).toBe('2026-04-03T19:00:00Z');
    expect(slots[2]!.end).toBe('2026-04-03T21:00:00Z');
  });

  it('handles back-to-back events with no gap', () => {
    const events = [
      makeEvent('2026-04-03T14:00:00Z', '2026-04-03T15:00:00Z'),
      makeEvent('2026-04-03T15:00:00Z', '2026-04-03T16:00:00Z'),
    ];

    const slots = findFreeSlots(events, dayStart, dayEnd);
    // Before events: 11:00-14:00, after events: 16:00-21:00
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
    // Before: 11:00-14:00, After: 17:00-21:00
    expect(slots).toHaveLength(2);
    expect(slots[0]!.end).toBe('2026-04-03T14:00:00Z');
    expect(slots[1]!.start).toBe('2026-04-03T17:00:00Z');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/calendar/free-slots.test.ts
```

- [ ] **Step 3: Implement src/calendar/free-slots.ts**

```typescript
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
    // Advance current past the end of this event (or keep it if already past)
    if (event.endTime > current) {
      current = event.endTime;
    }
  }

  // Gap after last event
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
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/calendar/free-slots.test.ts
```

Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add src/calendar/free-slots.ts tests/calendar/free-slots.test.ts
git commit -m "feat(calendar): add free slot finder"
```

---

## Task 6: Conflict Detection + Resolution

**Files:**
- Create: `src/calendar/conflicts.ts`
- Create: `tests/calendar/conflicts.test.ts`

- [ ] **Step 1: Write tests/calendar/conflicts.test.ts**

```typescript
import { describe, it, expect } from 'vitest';
import { detectConflicts } from '../../src/calendar/conflicts.js';
import type { UnifiedEvent, FreeSlot } from '../../src/calendar/types.js';

function makeEvent(overrides: Partial<UnifiedEvent>): UnifiedEvent {
  return {
    id: 'evt-1',
    source: 'outlook',
    calendarEmail: 'rob@dearborndenim.com',
    title: 'Meeting',
    startTime: '2026-04-03T14:00:00Z',
    endTime: '2026-04-03T15:00:00Z',
    location: '',
    isAllDay: false,
    status: 'confirmed',
    attendees: [],
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
      makeEvent({
        id: 'a',
        title: 'Big team meeting',
        startTime: '2026-04-03T14:00:00Z',
        endTime: '2026-04-03T15:00:00Z',
        attendees: ['a@x.com', 'b@x.com', 'c@x.com'],
      }),
      makeEvent({
        id: 'b',
        title: 'Quick 1:1',
        startTime: '2026-04-03T14:30:00Z',
        endTime: '2026-04-03T15:30:00Z',
        attendees: ['d@x.com'],
      }),
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
      makeEvent({
        id: 'a',
        startTime: '2026-04-03T14:00:00Z',
        endTime: '2026-04-03T15:00:00Z',
        attendees: ['1@x.com', '2@x.com', '3@x.com', '4@x.com', '5@x.com'],
      }),
      makeEvent({
        id: 'b',
        startTime: '2026-04-03T14:30:00Z',
        endTime: '2026-04-03T15:30:00Z',
        attendees: ['6@x.com', '7@x.com', '8@x.com', '9@x.com', '10@x.com'],
      }),
    ];

    const conflicts = detectConflicts(events, freeSlots);
    expect(conflicts[0]!.proposedMove).toBeNull();
    expect(conflicts[0]!.suggestion).toContain('Both events have 5+ attendees');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/calendar/conflicts.test.ts
```

- [ ] **Step 3: Implement src/calendar/conflicts.ts**

```typescript
import type { UnifiedEvent, ConflictResult, FreeSlot, ProposedMove } from './types.js';

export function detectConflicts(
  events: UnifiedEvent[],
  freeSlots: FreeSlot[],
): ConflictResult[] {
  const sorted = [...events].sort((a, b) => a.startTime.localeCompare(b.startTime));
  const conflicts: ConflictResult[] = [];

  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]!;
    const b = sorted[i + 1]!;

    if (a.endTime > b.startTime) {
      const overlapMs = new Date(a.endTime).getTime() - new Date(b.startTime).getTime();
      const overlapMinutes = Math.round(overlapMs / 60000);

      const resolution = proposeResolution(a, b, freeSlots);

      conflicts.push({
        eventA: a,
        eventB: b,
        overlapMinutes,
        suggestion: resolution.suggestion,
        proposedMove: resolution.proposedMove,
      });
    }
  }

  return conflicts;
}

const MAX_ATTENDEES_TO_MOVE = 4;

function proposeResolution(
  a: UnifiedEvent,
  b: UnifiedEvent,
  freeSlots: FreeSlot[],
): { suggestion: string; proposedMove: ProposedMove | null } {
  // Determine which event to move
  const aMovable = a.attendees.length <= MAX_ATTENDEES_TO_MOVE;
  const bMovable = b.attendees.length <= MAX_ATTENDEES_TO_MOVE;

  if (!aMovable && !bMovable) {
    return {
      suggestion: `Both events have 5+ attendees — manual resolution needed`,
      proposedMove: null,
    };
  }

  let eventToMove: UnifiedEvent;
  if (!aMovable) {
    eventToMove = b;
  } else if (!bMovable) {
    eventToMove = a;
  } else {
    // Move the one with fewer attendees
    eventToMove = a.attendees.length <= b.attendees.length ? a : b;
  }

  const durationMs = new Date(eventToMove.endTime).getTime() - new Date(eventToMove.startTime).getTime();
  const durationMinutes = Math.round(durationMs / 60000);

  // Find nearest free slot that fits
  const originalStart = new Date(eventToMove.startTime).getTime();
  const candidates = freeSlots
    .filter((slot) => slot.durationMinutes >= durationMinutes)
    .sort((a, b) => {
      const distA = Math.abs(new Date(a.start).getTime() - originalStart);
      const distB = Math.abs(new Date(b.start).getTime() - originalStart);
      return distA - distB;
    });

  if (candidates.length === 0) {
    return {
      suggestion: `No available slot today for "${eventToMove.title}" (${durationMinutes} min) — consider rescheduling`,
      proposedMove: null,
    };
  }

  const bestSlot = candidates[0]!;
  const newStart = bestSlot.start;
  const newEnd = new Date(new Date(newStart).getTime() + durationMs).toISOString();

  return {
    suggestion: `Move "${eventToMove.title}" to ${newStart}`,
    proposedMove: {
      eventToMove,
      newStartTime: newStart,
      newEndTime: newEnd,
      reason: `Resolves conflict with "${eventToMove === a ? b.title : a.title}"`,
    },
  };
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/calendar/conflicts.test.ts
```

Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add src/calendar/conflicts.ts tests/calendar/conflicts.test.ts
git commit -m "feat(calendar): add conflict detection and resolution"
```

---

## Task 7: Update Briefing Generator

**Files:**
- Modify: `src/briefing/generator.ts`
- Modify: `tests/briefing/generator.test.ts`

- [ ] **Step 1: Add calendar test to tests/briefing/generator.test.ts**

Add the following tests to the existing file:

```typescript
import { describe, it, expect } from 'vitest';
import { buildBriefingPrompt } from '../../src/briefing/generator.js';
import type { ClassifiedEmail } from '../../src/email/types.js';
import type { UnifiedEvent, ConflictResult, FreeSlot } from '../../src/calendar/types.js';

// ... keep existing makeClassified helper and tests ...

describe('buildBriefingPrompt with calendar', () => {
  it('includes calendar events in the prompt', () => {
    const calendarData = {
      events: [
        {
          id: 'evt-1',
          source: 'outlook' as const,
          calendarEmail: 'rob@dearborndenim.com',
          title: 'Team standup',
          startTime: '2026-04-03T14:30:00Z',
          endTime: '2026-04-03T15:00:00Z',
          location: 'Teams',
          isAllDay: false,
          status: 'confirmed' as const,
          attendees: [],
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

    const calendarData = {
      events: [],
      conflicts: [conflict],
      freeSlots: [],
      pendingActions: [],
    };

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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/briefing/generator.test.ts
```

Expected: FAIL — `buildBriefingPrompt` doesn't accept calendarData parameter yet.

- [ ] **Step 3: Update src/briefing/generator.ts**

Replace the entire file with:

```typescript
import Anthropic from '@anthropic-ai/sdk';
import type { ClassifiedEmail } from '../email/types.js';
import type { CalendarBriefingData } from '../calendar/types.js';

const BRIEFING_SYSTEM_PROMPT = `You are Rob McMillan's AI secretary generating his morning briefing.

Rob owns Dearborn Denim (rob@dearborndenim.com) and McMillan Manufacturing (robert@mcmillan-manufacturing.com). His personal email is mcmillanrken@gmail.com.

Generate a concise, actionable morning briefing in markdown format. Structure:

1. **Today's Schedule** — Calendar events for today with times (Chicago time), conflicts flagged with suggestions, and free time blocks. Only include if calendar data is provided.
2. **Needs Your Attention** — Critical/high urgency email items requiring a response. Include sender, one-line summary, and suggested action.
3. **For Your Review** — Medium priority items to look at when time allows.
4. **FYI / Handled** — What was auto-archived or marked as informational.
5. **Stats** — How many emails processed, archived, flagged.

Keep it conversational but direct. Rob is busy — lead with what matters.
Don't use emoji. Use Central Time (Chicago) for all times.`;

export interface BriefingStats {
  totalProcessed: number;
  archived: number;
  flaggedForReview: number;
}

export function buildBriefingPrompt(
  emails: ClassifiedEmail[],
  stats: BriefingStats,
  calendar?: CalendarBriefingData,
): string {
  const critical = emails.filter((e) => e.urgency === 'critical');
  const high = emails.filter((e) => e.urgency === 'high');
  const medium = emails.filter((e) => e.urgency === 'medium');
  const low = emails.filter((e) => e.urgency === 'low');

  const formatEmails = (list: ClassifiedEmail[]): string =>
    list.length === 0
      ? 'None'
      : list
          .map(
            (e) =>
              `- From: ${e.senderName} <${e.sender}> (${e.account})\n  Subject: ${e.subject}\n  Summary: ${e.summary}\n  Suggested action: ${e.suggestedAction}`,
          )
          .join('\n');

  let calendarSection = '';
  if (calendar) {
    const eventList = calendar.events.length === 0
      ? 'No events scheduled.'
      : calendar.events
          .map((e) => `- ${e.startTime} to ${e.endTime}: ${e.title} (${e.calendarEmail})${e.location ? ` — ${e.location}` : ''}`)
          .join('\n');

    const conflictList = calendar.conflicts.length === 0
      ? 'None'
      : calendar.conflicts
          .map((c) => `- CONFLICT: "${c.eventA.title}" overlaps with "${c.eventB.title}" by ${c.overlapMinutes} minutes.\n  Suggestion: ${c.suggestion ?? 'Manual resolution needed'}`)
          .join('\n');

    const freeList = calendar.freeSlots.length === 0
      ? 'No free blocks today.'
      : calendar.freeSlots
          .map((s) => `- ${s.start} to ${s.end} (${s.durationMinutes} min)`)
          .join('\n');

    const pendingList = calendar.pendingActions.length === 0
      ? ''
      : '\nPending actions awaiting approval:\n' +
        calendar.pendingActions.map((a) => `- ${a.description}`).join('\n');

    calendarSection = `
TODAY'S SCHEDULE:
${eventList}

CONFLICTS:
${conflictList}

FREE TIME BLOCKS:
${freeList}
${pendingList}
`;
  }

  return `Generate the morning briefing for today.

Stats:
- Total emails processed: ${stats.totalProcessed}
- Auto-archived: ${stats.archived}
- Flagged for review: ${stats.flaggedForReview}
${calendarSection}
CRITICAL urgency:
${formatEmails(critical)}

HIGH urgency:
${formatEmails(high)}

MEDIUM urgency:
${formatEmails(medium)}

LOW urgency:
${formatEmails(low)}`;
}

let anthropicClient: Anthropic | null = null;

export async function generateBriefing(
  emails: ClassifiedEmail[],
  stats: BriefingStats,
  calendar?: CalendarBriefingData,
): Promise<string> {
  if (!anthropicClient) {
    const { config } = await import('../config.js');
    anthropicClient = new Anthropic({ apiKey: config.anthropic.apiKey });
  }
  const client = anthropicClient;
  const prompt = buildBriefingPrompt(emails, stats, calendar);

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6-20250514',
    max_tokens: 2000,
    system: BRIEFING_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: prompt }],
  });

  return response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');
}
```

- [ ] **Step 4: Run all tests**

```bash
npx vitest run
```

Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add src/briefing/generator.ts tests/briefing/generator.test.ts
git commit -m "feat(calendar): add calendar section to morning briefing"
```

---

## Task 8: Update Main Orchestrator

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Update src/index.ts**

Add calendar imports and pipeline step. The full updated file:

```typescript
import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { config } from './config.js';
import { initializeSchema } from './db/schema.js';
import {
  insertProcessedEmail,
  getOrCreateSenderProfile,
  updateSenderProfile,
  insertAgentRun,
  completeAgentRun,
  insertAuditLog,
  getLastRunTimestamp,
} from './db/queries.js';
import {
  upsertCalendarEvent,
  insertPendingAction,
  getPendingActions,
  expirePendingActions,
  getWeeklySchedule,
} from './db/calendar-queries.js';
import { fetchUnreadOutlookEmails } from './email/outlook.js';
import { fetchUnreadGmailEmails } from './email/gmail.js';
import { classifyEmail } from './email/classifier.js';
import { determineAction, archiveOutlookEmail, markOutlookAsRead, categorizeOutlookEmail } from './email/actions.js';
import { generateBriefing } from './briefing/generator.js';
import { sendBriefingEmail } from './briefing/sender.js';
import { fetchOutlookCalendarEvents } from './calendar/outlook-calendar.js';
import { mergeEvents } from './calendar/merger.js';
import { findFreeSlots } from './calendar/free-slots.js';
import { detectConflicts } from './calendar/conflicts.js';
import { TIMEZONE, DEFAULT_WORK_START, DEFAULT_WORK_END } from './calendar/types.js';
import type { RawEmail, ClassifiedEmail } from './email/types.js';
import type { UnifiedEvent } from './calendar/types.js';
import type { CalendarBriefingData } from './calendar/types.js';

function getWorkBoundariesUtc(date: Date, workStart: string, workEnd: string): { dayStart: string; dayEnd: string } {
  const dateStr = date.toLocaleDateString('en-CA', { timeZone: TIMEZONE }); // YYYY-MM-DD
  // Convert Chicago local time to UTC by creating a date string and adjusting
  const startLocal = new Date(`${dateStr}T${workStart}:00`);
  const endLocal = new Date(`${dateStr}T${workEnd}:00`);

  // Get Chicago offset. Create a formatter to extract offset.
  const chicagoOffset = getChicagoOffsetMs(date);

  return {
    dayStart: new Date(startLocal.getTime() - chicagoOffset).toISOString(),
    dayEnd: new Date(endLocal.getTime() - chicagoOffset).toISOString(),
  };
}

function getChicagoOffsetMs(date: Date): number {
  // Use Intl to determine Chicago's UTC offset
  const utcDate = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
  const chicagoDate = new Date(date.toLocaleString('en-US', { timeZone: TIMEZONE }));
  return chicagoDate.getTime() - utcDate.getTime();
}

function getMondayOfWeek(date: Date): string {
  const d = new Date(date.toLocaleString('en-US', { timeZone: TIMEZONE }));
  const day = d.getDay(); // 0=Sun, 1=Mon, ...
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(d.setDate(diff));
  return monday.toLocaleDateString('en-CA', { timeZone: TIMEZONE }); // YYYY-MM-DD
}

async function main() {
  console.log('McSECREtary — overnight triage starting...');
  const startTime = Date.now();

  // Ensure data directory exists
  const dbDir = path.dirname(config.db.path);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  // Initialize database
  const db = new Database(config.db.path);
  db.pragma('journal_mode = WAL');
  initializeSchema(db);

  // Start run tracking
  const runId = insertAgentRun(db, 'overnight');
  const lastRun = getLastRunTimestamp(db, 'overnight');

  let totalProcessed = 0;
  let totalArchived = 0;
  let totalFlagged = 0;
  const allClassified: ClassifiedEmail[] = [];
  const errors: string[] = [];
  let calendarData: CalendarBriefingData | undefined;

  try {
    // 1. Fetch emails and calendar in parallel
    console.log('Fetching emails and calendar...');

    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 2);
    const calStartDate = now.toISOString();
    const calEndDate = tomorrow.toISOString();

    const [outlook1, outlook2, gmail, calEvents1, calEvents2] = await Promise.all([
      fetchUnreadOutlookEmails(config.outlook.email1, lastRun).catch((err) => {
        errors.push(`Outlook1 fetch failed: ${err.message}`);
        return [] as RawEmail[];
      }),
      fetchUnreadOutlookEmails(config.outlook.email2, lastRun).catch((err) => {
        errors.push(`Outlook2 fetch failed: ${err.message}`);
        return [] as RawEmail[];
      }),
      fetchUnreadGmailEmails(lastRun).catch((err) => {
        errors.push(`Gmail fetch failed: ${err.message}`);
        return [] as RawEmail[];
      }),
      fetchOutlookCalendarEvents(config.outlook.email1, calStartDate, calEndDate).catch((err) => {
        errors.push(`Outlook1 calendar fetch failed: ${err.message}`);
        return [] as UnifiedEvent[];
      }),
      fetchOutlookCalendarEvents(config.outlook.email2, calStartDate, calEndDate).catch((err) => {
        errors.push(`Outlook2 calendar fetch failed: ${err.message}`);
        return [] as UnifiedEvent[];
      }),
    ]);

    const allEmails = [...outlook1, ...outlook2, ...gmail];
    console.log(`Fetched ${allEmails.length} unread emails (${outlook1.length} OL1, ${outlook2.length} OL2, ${gmail.length} Gmail)`);

    // 2. Process calendar
    console.log('Processing calendar...');
    const allCalEvents = [...calEvents1, ...calEvents2];
    console.log(`Fetched ${allCalEvents.length} calendar events (${calEvents1.length} OL1, ${calEvents2.length} OL2)`);

    // Cache events in DB
    for (const evt of allCalEvents) {
      upsertCalendarEvent(db, {
        id: evt.id,
        source: evt.source,
        calendar_email: evt.calendarEmail,
        title: evt.title,
        start_time: evt.startTime,
        end_time: evt.endTime,
        location: evt.location,
        is_all_day: evt.isAllDay ? 1 : 0,
        status: evt.status,
        attendees: JSON.stringify(evt.attendees),
      });
    }

    // Merge and analyze today's events
    const merged = mergeEvents(allCalEvents);

    // Get weekly schedule for today
    const weekStart = getMondayOfWeek(now);
    const schedule = getWeeklySchedule(db, weekStart);
    const todayDow = (now.getDay() + 6) % 7; // Convert Sun=0 to Mon=0
    const todaySchedule = schedule.find((s) => s.day_of_week === todayDow);
    const workStart = todaySchedule?.work_start ?? DEFAULT_WORK_START;
    const workEnd = todaySchedule?.work_end ?? DEFAULT_WORK_END;

    // Calculate work boundaries in UTC
    const { dayStart, dayEnd } = getWorkBoundariesUtc(now, workStart, workEnd);

    // Filter to today's events only for conflict detection
    const todayEvents = merged.filter((e) => e.startTime >= dayStart && e.startTime < dayEnd);

    const freeSlots = findFreeSlots(todayEvents, dayStart, dayEnd);
    const conflicts = detectConflicts(todayEvents, freeSlots);

    // Expire old pending actions and create new ones from conflicts
    expirePendingActions(db, now.toISOString());

    for (const conflict of conflicts) {
      if (conflict.proposedMove) {
        const move = conflict.proposedMove;
        const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
        insertPendingAction(db, {
          action_type: 'move_event',
          source_event_id: move.eventToMove.id,
          source: move.eventToMove.source,
          calendar_email: move.eventToMove.calendarEmail,
          description: conflict.suggestion ?? `Move "${move.eventToMove.title}"`,
          proposed_data: JSON.stringify({
            newStartTime: move.newStartTime,
            newEndTime: move.newEndTime,
            reason: move.reason,
          }),
          status: 'pending',
          expires_at: expiresAt,
        });
      }
    }

    const pendingActions = getPendingActions(db);

    calendarData = {
      events: todayEvents,
      conflicts,
      freeSlots,
      pendingActions,
    };

    // 3. Classify each email
    console.log('Classifying emails...');
    for (const email of allEmails) {
      try {
        const classified = await classifyEmail(email);
        allClassified.push(classified);

        getOrCreateSenderProfile(db, classified.sender, classified.senderName);
        updateSenderProfile(db, classified.sender, classified.category, classified.urgency);

        const action = determineAction(classified);

        if (action.type === 'archive' && classified.account !== config.gmail.userEmail) {
          await archiveOutlookEmail(classified.account, classified.id);
          totalArchived++;
        } else if (action.type === 'mark_read' && classified.account !== config.gmail.userEmail) {
          await markOutlookAsRead(classified.account, classified.id);
        }

        if (action.type === 'flag_for_review') {
          totalFlagged++;
        }

        if (classified.account !== config.gmail.userEmail) {
          await categorizeOutlookEmail(classified.account, classified.id, classified.category).catch(() => {});
        }

        insertProcessedEmail(db, {
          id: classified.id,
          account: classified.account,
          sender: classified.sender,
          sender_name: classified.senderName,
          subject: classified.subject,
          received_at: classified.receivedAt,
          category: classified.category,
          urgency: classified.urgency,
          action_needed: classified.actionNeeded,
          action_taken: action.type,
          confidence: classified.confidence,
          summary: classified.summary,
          thread_id: classified.threadId,
        });

        insertAuditLog(db, {
          action_type: action.type,
          target_id: classified.id,
          target_type: 'email',
          details: JSON.stringify({ category: classified.category, urgency: classified.urgency, reason: action.reason }),
          confidence: classified.confidence,
        });

        totalProcessed++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Failed to process email ${email.id}: ${msg}`);
      }
    }

    // 4. Generate and send morning briefing
    console.log('Generating morning briefing...');
    const briefing = await generateBriefing(allClassified, {
      totalProcessed,
      archived: totalArchived,
      flaggedForReview: totalFlagged,
    }, calendarData);

    console.log('Sending briefing email...');
    await sendBriefingEmail(briefing);

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Fatal error: ${msg}`);
    console.error('Fatal error:', msg);
  }

  // 5. Complete run tracking
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  completeAgentRun(db, runId, {
    emails_processed: totalProcessed,
    actions_taken: totalArchived + totalFlagged,
    tokens_used: 0,
    cost_estimate: 0,
  });

  if (errors.length > 0) {
    console.warn(`Completed with ${errors.length} errors:`, errors);
  }

  console.log(`McSECREtary run complete in ${elapsed}s — ${totalProcessed} emails processed, ${totalArchived} archived, ${totalFlagged} flagged`);

  db.close();
}

main().catch((err) => {
  console.error('McSECREtary crashed:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Run all tests**

```bash
npx vitest run
```

Expected: All pass.

- [ ] **Step 3: Run typecheck**

```bash
npx tsc --noEmit
```

Expected: Clean.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat(calendar): integrate calendar pipeline into main orchestrator"
```

---

## Task 9: Final Verification + Push

**Files:**
- No new files

- [ ] **Step 1: Run full test suite**

```bash
npx vitest run
```

Expected: All tests pass.

- [ ] **Step 2: Run typecheck**

```bash
npx tsc --noEmit
```

Expected: Clean, no errors.

- [ ] **Step 3: Verify git log**

```bash
git log --oneline -10
```

Should show all Phase 2 commits on top of Phase 1.

- [ ] **Step 4: Push to GitHub (triggers Railway deploy)**

```bash
git push
```

- [ ] **Step 5: Verify Railway build**

```bash
railway service status --service mcsecretary-triage
```
