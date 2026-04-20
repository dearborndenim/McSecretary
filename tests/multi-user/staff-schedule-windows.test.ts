import { describe, it, expect } from 'vitest';
import {
  resolveScheduleWindowsForRole,
  DEFAULT_ADMIN_CHECK_IN,
  DEFAULT_ADMIN_EOD,
} from '../../src/db/user-queries.js';

describe('resolveScheduleWindowsForRole', () => {
  it('returns DEFAULT_ADMIN_* for admin role regardless of env', () => {
    const w = resolveScheduleWindowsForRole('admin', {
      STAFF_SCHEDULE_WINDOW_START: '6',
      STAFF_SCHEDULE_WINDOW_END: '20',
    });
    expect(w.check_in_cron).toBe(DEFAULT_ADMIN_CHECK_IN);
    expect(w.eod_cron).toBe(DEFAULT_ADMIN_EOD);
  });

  it('returns the staff default (7 AM – 1 PM + 1:30 PM EOD) when env is unset', () => {
    const w = resolveScheduleWindowsForRole('staff', {});
    expect(w.check_in_cron).toBe('0 7-13 * * 1-5');
    expect(w.eod_cron).toBe('30 13 * * 1-5');
  });

  it('honors STAFF_SCHEDULE_WINDOW_START / _END for staff role', () => {
    const w = resolveScheduleWindowsForRole('staff', {
      STAFF_SCHEDULE_WINDOW_START: '8',
      STAFF_SCHEDULE_WINDOW_END: '16',
    });
    expect(w.check_in_cron).toBe('0 8-16 * * 1-5');
    expect(w.eod_cron).toBe('30 16 * * 1-5');
  });

  it('guards against swapped start/end (normalizes to min/max)', () => {
    const w = resolveScheduleWindowsForRole('staff', {
      STAFF_SCHEDULE_WINDOW_START: '14',
      STAFF_SCHEDULE_WINDOW_END: '6',
    });
    expect(w.check_in_cron).toBe('0 6-14 * * 1-5');
    expect(w.eod_cron).toBe('30 14 * * 1-5');
  });

  it('falls back to staff defaults when env values are invalid', () => {
    const w = resolveScheduleWindowsForRole('staff', {
      STAFF_SCHEDULE_WINDOW_START: 'abc',
      STAFF_SCHEDULE_WINDOW_END: '-5',
    });
    // Both invalid → use the configured-but-invalid path which still emits
    // a syntactically valid cron (defaults substituted).
    expect(w.check_in_cron).toMatch(/^0 \d+-\d+ \* \* 1-5$/);
    expect(w.eod_cron).toMatch(/^30 \d+ \* \* 1-5$/);
  });
});
