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

  it('takes the rest of the line as the value when only one key= is present', () => {
    expect(parseEdit('summary=Only the waffle knit one, please.')).toEqual({
      ok: true, fields: { summary: 'Only the waffle knit one, please.' },
    });
  });

  it('still splits on whitespace when a second key=value token is present', () => {
    expect(parseEdit('monthly_usd=10000 note=hold')).toEqual({
      ok: true, fields: { monthly_usd: 10000, note: 'hold' },
    });
  });

  it('still refuses a stray non-key token once the line is multi-key (unchanged)', () => {
    expect(parseEdit('monthly_usd=10000 note=hold it')).toEqual({
      ok: false, reason: 'Use key=value pairs, e.g. monthly_usd=10000',
    });
  });

  it('keeps coercion on a single-token value', () => {
    expect(parseEdit('monthly_usd=10000')).toEqual({ ok: true, fields: { monthly_usd: 10000 } });
    expect(parseEdit('flag=false')).toEqual({ ok: true, fields: { flag: false } });
  });

  it('rejects an empty message, a bare key= and a line that does not start with a key', () => {
    const hint = { ok: false, reason: 'Use key=value pairs, e.g. monthly_usd=10000' };
    expect(parseEdit('   ')).toEqual(hint);
    expect(parseEdit('summary=')).toEqual(hint);
    expect(parseEdit('summary =text')).toEqual(hint);
    expect(parseEdit('please set summary=x')).toEqual(hint);
  });

  it("round-trips the graph card's own Edit hint", () => {
    const plan = { summary: 'old summary', briefs: [], vendor_contacts: [], run_requests: [] };
    const payload: ActionPayload = { hand: 'graph', method: 'POST', path: '/dispatch', body: plan };
    const parsed = parseEdit('summary=Only the waffle knit one, both lines');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const applied = applyEdit(payload, parsed.fields);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.payload.body.summary).toBe('Only the waffle knit one, both lines');
    expect(applied.payload.body.briefs).toEqual([]);
  });
});
