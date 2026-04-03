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
    eventToMove = a.attendees.length <= b.attendees.length ? a : b;
  }

  const durationMs = new Date(eventToMove.endTime).getTime() - new Date(eventToMove.startTime).getTime();
  const durationMinutes = Math.round(durationMs / 60000);

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
