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

export interface CalendarBriefingData {
  events: UnifiedEvent[];
  conflicts: ConflictResult[];
  freeSlots: FreeSlot[];
  pendingActions: { description: string }[];
}
