# Phase 2: Calendar Unification — Design Spec

**Date:** 2026-04-03
**Status:** Draft

---

## Goal

Add calendar awareness to McSecretary's overnight triage run. Fetch events from Outlook Calendar (both accounts), merge into a unified timeline, detect conflicts, propose resolutions, find free time blocks, and include a calendar section in the morning briefing.

## Architecture

Phase 2 adds a `calendar/` module to the existing Railway cron job. On each run:

1. Fetch today + tomorrow events from Outlook Calendar (both accounts) via Graph API
2. Merge into a unified timeline in `America/Chicago` timezone
3. Load weekly schedule preferences (gym vs. bike, work hours)
4. Detect conflicts (overlapping events)
5. Find free slots within work hours
6. Propose conflict resolutions (move events to free slots), store as pending actions
7. Cache events in SQLite
8. Pass calendar data to the briefing generator

**Calendar sources:**
- Outlook Calendar for `rob@dearborndenim.com` — read+write via Graph API (existing auth)
- Outlook Calendar for `robert@mcmillan-manufacturing.com` — read+write via Graph API (existing auth)
- Google Calendar — excluded from Phase 2 (limited scope, planned deprecation)
- Apple Calendar — designed into data model, implemented later (requires Mac Mini)

## Data Model

### `calendar_events` — Unified event cache

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | Source event ID |
| source | TEXT | `outlook` (future: `google`, `apple`) |
| calendar_email | TEXT | Which account (e.g., `rob@dearborndenim.com`) |
| title | TEXT | Event subject |
| start_time | TEXT | UTC ISO 8601 |
| end_time | TEXT | UTC ISO 8601 |
| location | TEXT | Event location |
| is_all_day | INTEGER | 0 or 1 |
| status | TEXT | `confirmed`, `tentative`, `cancelled` |
| attendees | TEXT | JSON array of attendee emails |
| fetched_at | TEXT | When this was last pulled from the API |

This is a cache refreshed every run, not the source of truth.

### `weekly_schedule` — Weekly preferences

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment |
| week_start | TEXT | Monday date (YYYY-MM-DD) |
| day_of_week | INTEGER | 0=Monday through 6=Sunday |
| work_start | TEXT | Time string, default `06:00` |
| work_end | TEXT | Time string, default `16:00` |
| morning_routine | TEXT | `bike`, `gym`, or `default` |
| notes | TEXT | Free text for special circumstances |

**Defaults (when no row exists for a day):**
- Work hours: 6:00 AM – 4:00 PM
- Morning routine: `default` (no gym/bike block)
- Weekends: no work (no events suggested)

**Morning routine effects:**
- `bike`: 50-minute commute block before work_start. No gym block.
- `gym`: 1-hour gym block before work_start, shorter commute (drive).
- `default`: No morning block.

### `pending_actions` — Proposed calendar modifications

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment |
| created_at | TEXT | When proposed |
| action_type | TEXT | `move_event`, `cancel_event`, `create_event` |
| source_event_id | TEXT | FK to the event being modified |
| source | TEXT | `outlook` |
| calendar_email | TEXT | Which account |
| description | TEXT | Human-readable: "Move dentist from 2:00 PM to 3:30 PM" |
| proposed_data | TEXT | JSON with new start/end times or event details |
| status | TEXT | `pending`, `approved`, `rejected`, `expired` |
| expires_at | TEXT | Auto-expire after 24 hours |

## Module Structure

### New files

- `src/calendar/types.ts` — Interfaces: UnifiedEvent, ConflictResult, FreeSlot, WeeklyScheduleDay, PendingAction
- `src/calendar/outlook-calendar.ts` — Fetch events from Outlook Calendar via Graph API
- `src/calendar/merger.ts` — Merge events from multiple sources, normalize to America/Chicago, sort, deduplicate (by matching subject + start time across accounts)
- `src/calendar/conflicts.ts` — Detect overlapping events, propose resolutions
- `src/calendar/free-slots.ts` — Find available time blocks within work hours, respecting weekly schedule
- `src/db/calendar-schema.ts` — CREATE TABLE for calendar_events, weekly_schedule, pending_actions
- `src/db/calendar-queries.ts` — Typed insert/query/update helpers for calendar tables

### Modified files

- `src/index.ts` — Add calendar fetch + conflict detection to the pipeline
- `src/briefing/generator.ts` — Add calendar section to briefing prompt
- `src/db/schema.ts` — Import and call calendar schema initialization

### Unchanged files

All email modules, auth/graph.ts, briefing/sender.ts, config.ts — no changes needed.

## Pipeline Flow

```
Phase 1 (unchanged):
  Fetch emails (3 accounts) → Classify → Act

Phase 2 (new, runs in parallel with email fetch):
  Fetch Outlook calendars (2 accounts, parallel)
  → Merge + normalize to Chicago time
  → Load weekly schedule for today
  → Detect conflicts
  → Find free slots
  → Propose resolutions → Store in pending_actions
  → Cache events in calendar_events

Combined:
  Generate briefing (emails + calendar) → Send
```

## Conflict Detection & Resolution

### What counts as a conflict
- Two events whose time ranges overlap (start_A < end_B AND start_B < end_A)
- Excludes all-day events
- Excludes cancelled/declined events

### Which event gets moved
- Prefer moving the event with fewer attendees (less disruption)
- If equal, prefer moving the later-created event
- Never move events with 5+ attendees (suggest the other one instead)

### How a new time is picked
1. Get today's free slots from `free-slots.ts`
2. Filter to slots long enough for the event's duration
3. Filter out slots that conflict with weekly schedule blocks (gym/bike)
4. Pick the nearest slot to the original event time
5. If no slot fits today: "No available slot today — consider rescheduling"

### Pending action lifecycle
- Created during cron run → status `pending`
- Expires after 24 hours automatically
- Phase 4 (iMessage) will add approve/reject via text message
- For now, pending actions are surfaced in the briefing only

## Briefing Calendar Section

Added to the existing morning briefing between "Needs Your Attention" and "Today's Tasks":

```
## Today's Schedule
- 5:00 AM — Gym (weekly schedule)
- 6:00 AM — Start work
- 9:30 AM — Team standup (Outlook - Dearborn Denim)
- 11:00 AM — Fabric supplier call (Outlook - Dearborn Denim)
- 2:00 PM — Free block (2 hours)
- 4:00 PM — End of work day

## Conflicts
- CONFLICT: Supplier call (11:00-12:00) overlaps with Dentist (11:30-12:30)
  Suggestion: Move dentist to 2:00 PM (next free slot). Pending your approval.

## Free Time
- 7:00-9:30 AM (2.5 hours)
- 2:00-4:00 PM (2 hours)
```

## Weekly Schedule Management

For Phase 2, the weekly schedule can be set by:
- Inserting rows directly (via Cowork conversation)
- Defaults apply when no rows exist

Phase 4 will add iMessage-based weekly planning:
- "Rob, it's Sunday evening. What does your week look like? Biking any days?"
- Rob replies, McSecretary populates `weekly_schedule`

## Scheduling Preferences

**Defaults (Rob's current schedule):**
- Work days: Monday–Friday
- Work hours: 6:00 AM – 4:00 PM Central
- Gym mornings: 1 hour gym block (~5:00-6:00 AM), then drive to work
- Bike mornings: 50 minute commute, no gym block
- No protected lunch block
- After 4 PM: personal/family time, don't suggest work events

## What Phase 2 Does NOT Include

- Google Calendar integration (excluded per Rob's decision)
- Apple Calendar integration (data model supports it, implementation in later phase)
- iMessage approval of pending actions (Phase 4)
- Weekly planning conversation via iMessage (Phase 4)
- Proactive time-blocking suggestions (Phase 4)
- Event creation or meeting scheduling (Phase 3/4)
