import { describe, it, expect } from 'vitest';
import { readCapped } from '../src/http-util.js';

function chunked(chunks: Uint8Array[], onPull?: () => void, onCancel?: () => void): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) { onPull?.(); const next = chunks[i++]; if (next) c.enqueue(next); else c.close(); },
    cancel() { onCancel?.(); },
  }, { highWaterMark: 0 });
}
const enc = (s: string) => new TextEncoder().encode(s);

describe('readCapped', () => {
  it('concatenates chunks as bytes so a split multi-byte char survives', async () => {
    const bytes = enc('fit — best'); // em dash is 3 bytes
    const cut = bytes.indexOf(0xe2) + 1;
    const res = new Response(chunked([bytes.subarray(0, cut), bytes.subarray(cut, cut + 1), bytes.subarray(cut + 1)]));
    expect(await readCapped(res, 1024)).toEqual({ ok: true, text: 'fit — best' });
  });

  it('cancels the reader and reports not-ok once the byte total exceeds the cap', async () => {
    let pulls = 0; let cancelled = false;
    const res = new Response(chunked([enc('aaaa'), enc('bbbb'), enc('cccc')], () => { pulls++; }, () => { cancelled = true; }));
    expect(await readCapped(res, 7)).toEqual({ ok: false });
    expect(cancelled).toBe(true);
    expect(pulls).toBe(2); // third chunk never requested
  });

  it('accepts a body of exactly the cap', async () => {
    const res = new Response(chunked([enc('aaaa'), enc('bbb')]));
    expect(await readCapped(res, 7)).toEqual({ ok: true, text: 'aaaabbb' });
  });

  it('refuses on Content-Length above the cap without reading the body', async () => {
    let pulled = false;
    const res = new Response(chunked([enc('x')], () => { pulled = true; }), { headers: { 'Content-Length': '5000000' } });
    expect(await readCapped(res, 1_048_576)).toEqual({ ok: false });
    expect(pulled).toBe(false);
  });

  it('returns an empty string for a bodyless response', async () => {
    expect(await readCapped(new Response(null, { status: 204 }), 10)).toEqual({ ok: true, text: '' });
  });
});
