import { describe, it, expect } from 'vitest';
import { parseEdit, applyEdit } from '../../src/spine/edits.js';
import type { ActionPayload } from '../../src/spine/types.js';

const P: ActionPayload = { hand: 'ad-manager', method: 'POST', path: '/api/spend', body: { monthly_usd: 15000, note: 'x', flag: true } };

describe('edits', () => {
  it('parses key=value pairs with numbers, booleans, strings', () => {
    expect(parseEdit('monthly_usd=10000 flag=false note=hold')).toEqual({
      ok: true, fields: { monthly_usd: 10000, flag: false, note: 'hold' },
    });
  });

  it('rejects free text', () => {
    expect(parseEdit('make it ten thousand')).toEqual({ ok: false, reason: 'Use key=value pairs, e.g. monthly_usd=10000' });
  });

  it('rejects keys not present in the body', () => {
    const r = applyEdit(P, { monthly_usd: 10000, bogus: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/bogus/);
  });

  it('applies to body only and never touches hand/method/path', () => {
    const r = applyEdit(P, { monthly_usd: 10000 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.payload.body.monthly_usd).toBe(10000);
      expect(r.payload.hand).toBe('ad-manager');
      expect(r.payload.path).toBe('/api/spend');
    }
    expect(P.body.monthly_usd).toBe(15000); // no mutation
  });

  it('refuses to change the type of a field', () => {
    const r = applyEdit(P, { monthly_usd: 'lots' });
    expect(r.ok).toBe(false);
  });
});
