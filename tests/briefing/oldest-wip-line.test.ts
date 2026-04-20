import { describe, it, expect } from 'vitest';
import { formatOldestWipLine, type WipSummary } from '../../src/briefing/wip.js';

describe('formatOldestWipLine', () => {
  it('returns null when summary is null so briefing can skip the line silently', () => {
    expect(formatOldestWipLine(null)).toBeNull();
  });

  it('falls back to the highest-count operation when oldest_operation is absent', () => {
    const summary: WipSummary = {
      as_of: '2026-04-18T03:00:00Z',
      total_in_flight: 235,
      oldest_wip_age_hours: 42.5,
      pieces_by_operation: { cut: 120, sew: 80, hem: 35 },
    };
    const line = formatOldestWipLine(summary);
    expect(line).toBe('⏳ Oldest WIP: cut piece — 42.5h old');
  });

  it('uses oldest_operation when the API surfaces it directly', () => {
    const summary: WipSummary = {
      as_of: '2026-04-18T03:00:00Z',
      total_in_flight: 235,
      oldest_wip_age_hours: 50.0,
      pieces_by_operation: { cut: 120, sew: 80, hem: 35 },
      oldest_operation: 'hem',
    };
    const line = formatOldestWipLine(summary);
    expect(line).toBe('⏳ Oldest WIP: hem piece — 50.0h old');
  });

  it('picks max-by-age from pieces_by_operation_oldest_age when present', () => {
    const summary: WipSummary = {
      as_of: '2026-04-18T03:00:00Z',
      total_in_flight: 235,
      oldest_wip_age_hours: 50.0,
      pieces_by_operation: { cut: 120, sew: 80, hem: 35 },
      pieces_by_operation_oldest_age: { cut: 1, sew: 5, hem: 50 },
    };
    const line = formatOldestWipLine(summary);
    expect(line).toBe('⏳ Oldest WIP: hem piece — 50.0h old');
  });

  it('returns null when total_in_flight is zero (nothing actually in flight)', () => {
    const summary: WipSummary = {
      as_of: '2026-04-18T03:00:00Z',
      total_in_flight: 0,
      oldest_wip_age_hours: 0,
      pieces_by_operation: {},
    };
    expect(formatOldestWipLine(summary)).toBeNull();
  });

  it('returns null when pieces_by_operation is empty and no fallbacks are available', () => {
    const summary: WipSummary = {
      as_of: '2026-04-18T03:00:00Z',
      total_in_flight: 10,
      oldest_wip_age_hours: 5,
      pieces_by_operation: {},
    };
    expect(formatOldestWipLine(summary)).toBeNull();
  });
});
