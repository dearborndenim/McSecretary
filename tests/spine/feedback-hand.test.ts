import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendFeedbackRow, readFeedbackRows, validateFeedbackPayload, type FeedbackBody } from '../../src/spine/feedback-hand.js';

const SPEC_EXAMPLE = (JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'design-feedback.json'), 'utf8')) as { body: FeedbackBody }).body;

const payload = (body: Record<string, unknown>, over: Record<string, unknown> = {}) =>
  ({ method: 'POST', path: '/feedback', body, ...over });

describe('validateFeedbackPayload', () => {
  it('accepts the spec example', () => {
    expect(validateFeedbackPayload(payload({ ...SPEC_EXAMPLE }), 'dearborn-denim')).toEqual({ ok: true, body: SPEC_EXAMPLE });
  });

  it('refuses unknown to_agent, from, kind and severity, a long suggestion, a foreign brand and stray keys', () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ to_agent: 'costing' }, /to_agent must be one of designer/],
      [{ from: 'merchandiser' }, /from must be one of/],
      [{ kind: 'too_expensive' }, /kind must be one of/],
      [{ severity: 'urgent' }, /severity must be one of block\|revise\|info/],
      [{ suggestion: 'x'.repeat(601) }, /suggestion must be a string of at most 600/],
      [{ brand: 'knits' }, /must equal the proposal brand_id/],
      [{ prompt: '../etc' }, /prompt must be a prompt slug/],
      [{ revision: 0 }, /revision must be an integer >= 1/],
      [{ product_index: -1 }, /product_index/],
      [{ detail: 'cheap' }, /detail must be an object/],
      [{ verdict: 'rejected' }, /verdict is not a feedback field/],
    ];
    for (const [over, err] of cases) {
      const r = validateFeedbackPayload(payload({ ...SPEC_EXAMPLE, ...over }), 'dearborn-denim');
      expect(r.ok, JSON.stringify(over)).toBe(false);
      if (!r.ok) expect(r.error).toMatch(err);
    }
    expect(validateFeedbackPayload(payload({ ...SPEC_EXAMPLE }, { path: '/note' }), 'dearborn-denim').ok).toBe(false);
  });

  it('allows a 600-char suggestion and no suggestion at all', () => {
    expect(validateFeedbackPayload(payload({ ...SPEC_EXAMPLE, suggestion: 'x'.repeat(600) }), 'dearborn-denim').ok).toBe(true);
    const { suggestion: _s, ...noSuggestion } = SPEC_EXAMPLE;
    expect(validateFeedbackPayload(payload(noSuggestion), 'dearborn-denim').ok).toBe(true);
  });
});

describe('appendFeedbackRow', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-')); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('creates the store, appends one row per proposal and is idempotent per proposal_id', () => {
    const a = appendFeedbackRow(root, SPEC_EXAMPLE, 11, '2026-10-15T10:00:00.000Z');
    expect(a).toMatchObject({ ok: true, rows: 1, path: 'designer/feedback/dearborn-denim/fall-workwear-2027.json', appended: true });
    const again = appendFeedbackRow(root, SPEC_EXAMPLE, 11, '2026-10-15T10:05:00.000Z');
    expect(again).toMatchObject({ rows: 1, appended: false });
    const b = appendFeedbackRow(root, { ...SPEC_EXAMPLE, from: 'wall', kind: 'note', severity: 'info' }, 12, '2026-10-15T10:06:00.000Z');
    expect(b.rows).toBe(2);

    const rows = readFeedbackRows(root, 'designer', 'dearborn-denim', 'fall-workwear-2027');
    expect(rows).toEqual([
      { ...SPEC_EXAMPLE, received_at: '2026-10-15T10:00:00.000Z', proposal_id: 11 },
      { ...SPEC_EXAMPLE, from: 'wall', kind: 'note', severity: 'info', received_at: '2026-10-15T10:06:00.000Z', proposal_id: 12 },
    ]);
    // temp file renamed into place and the lock released: nothing else left beside the store
    expect(fs.readdirSync(path.join(root, 'designer', 'feedback', 'dearborn-denim'))).toEqual(['fall-workwear-2027.json']);
  });

  it('never clobbers a store file that is not a JSON array', () => {
    const file = path.join(root, 'designer', 'feedback', 'dearborn-denim', 'fall-workwear-2027.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"oops":true}');
    expect(() => appendFeedbackRow(root, SPEC_EXAMPLE, 11, '2026-10-15T10:00:00.000Z')).toThrow(/not a JSON array/);
    expect(fs.readFileSync(file, 'utf8')).toBe('{"oops":true}');
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
  });

  it('breaks a stale lock left by a crash', () => {
    const file = path.join(root, 'designer', 'feedback', 'dearborn-denim', 'fall-workwear-2027.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.lock`, '');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(`${file}.lock`, old, old);
    expect(appendFeedbackRow(root, SPEC_EXAMPLE, 11, '2026-10-15T10:00:00.000Z').rows).toBe(1);
  });

  it('reads [] before anything was filed', () => {
    expect(readFeedbackRows(root, 'designer', 'knits', 'nothing-yet')).toEqual([]);
  });
});
