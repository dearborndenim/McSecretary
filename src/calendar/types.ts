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

export const TIMEZONE = 'America/Chicago';

export const DEFAULT_WORK_START = '06:00';
export const DEFAULT_WORK_END = '16:00';

export interface CalendarBriefingData {
  events: UnifiedEvent[];
  conflicts: ConflictResult[];
  freeSlots: FreeSlot[];
  pendingActions: { description: string }[];
}
