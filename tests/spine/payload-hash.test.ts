import { describe, it, expect } from 'vitest';
import { hashPayload } from '../../src/spine/payload-hash.js';

describe('hashPayload', () => {
  it('is stable across key order', () => {
    const a = hashPayload({ hand: 'x', method: 'POST', path: '/a', body: { b: 1, a: 2 } });
    const b = hashPayload({ body: { a: 2, b: 1 }, path: '/a', method: 'POST', hand: 'x' });
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it('changes when any value changes', () => {
    const a = hashPayload({ hand: 'x', method: 'POST', path: '/a', body: { n: 1 } });
    const b = hashPayload({ hand: 'x', method: 'POST', path: '/a', body: { n: 2 } });
    expect(a).not.toBe(b);
  });

  it('sorts nested keys and arrays are order-sensitive', () => {
    const a = hashPayload({ hand: 'x', method: 'POST', path: '/a', body: { list: [1, 2], o: { z: 1, y: 2 } } });
    const b = hashPayload({ hand: 'x', method: 'POST', path: '/a', body: { o: { y: 2, z: 1 }, list: [1, 2] } });
    const c = hashPayload({ hand: 'x', method: 'POST', path: '/a', body: { o: { y: 2, z: 1 }, list: [2, 1] } });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('treats undefined like JSON.stringify: dropped in objects, null in arrays', () => {
    const base = { hand: 'x', method: 'POST' as const, path: '/a' };
    expect(hashPayload({ ...base, body: { a: 1, b: undefined } })).toBe(hashPayload({ ...base, body: { a: 1 } }));
    expect(hashPayload({ ...base, body: { l: [1, undefined] } })).toBe(hashPayload({ ...base, body: { l: [1, null] } }));
  });
});
