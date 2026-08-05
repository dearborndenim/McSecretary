import { describe, it, expect } from 'vitest';
import { overnightDevFetchDisabled } from '../../src/briefing/sections.js';

describe('overnightDevFetchDisabled', () => {
  it('returns true only when DISABLE_OVERNIGHT_DEV_SECTION is the literal "1"', () => {
    expect(overnightDevFetchDisabled({ DISABLE_OVERNIGHT_DEV_SECTION: '1' })).toBe(true);
  });

  it('returns false when the var is unset', () => {
    expect(overnightDevFetchDisabled({})).toBe(false);
  });

  it('returns false for non-"1" values (0, true, empty string)', () => {
    expect(overnightDevFetchDisabled({ DISABLE_OVERNIGHT_DEV_SECTION: '0' })).toBe(false);
    expect(overnightDevFetchDisabled({ DISABLE_OVERNIGHT_DEV_SECTION: 'true' })).toBe(false);
    expect(overnightDevFetchDisabled({ DISABLE_OVERNIGHT_DEV_SECTION: '' })).toBe(false);
  });

  it('defaults to process.env when no env object is passed', () => {
    const prev = process.env.DISABLE_OVERNIGHT_DEV_SECTION;
    try {
      process.env.DISABLE_OVERNIGHT_DEV_SECTION = '1';
      expect(overnightDevFetchDisabled()).toBe(true);
      delete process.env.DISABLE_OVERNIGHT_DEV_SECTION;
      expect(overnightDevFetchDisabled()).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.DISABLE_OVERNIGHT_DEV_SECTION;
      else process.env.DISABLE_OVERNIGHT_DEV_SECTION = prev;
    }
  });
});
