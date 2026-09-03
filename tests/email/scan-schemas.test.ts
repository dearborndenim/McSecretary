import { describe, it, expect } from 'vitest';
import {
  EMAIL_SCAN_OUTPUT_FORMAT,
  parseEmailScanResponse,
  CLEANUP_OUTPUT_FORMAT,
  CLEANUP_SYSTEM_PROMPT,
  parseCleanupResponse,
} from '../../src/email/scan-schemas.js';

describe('EMAIL_SCAN_OUTPUT_FORMAT (MCS-4)', () => {
  it('is a strict json_schema: closed objects, required keys, integer index + boolean spam', () => {
    expect(EMAIL_SCAN_OUTPUT_FORMAT.type).toBe('json_schema');
    const root = EMAIL_SCAN_OUTPUT_FORMAT.schema as any;
    expect(root.additionalProperties).toBe(false);
    expect(root.required).toEqual(['classifications']);
    const item = root.properties.classifications.items;
    expect(item.additionalProperties).toBe(false);
    expect(item.required).toEqual(['index', 'spam']);
    expect(item.properties.index.type).toBe('integer');
    expect(item.properties.spam.type).toBe('boolean');
  });
});

describe('parseEmailScanResponse', () => {
  it('returns the classifications array from a conforming payload', () => {
    const text = JSON.stringify({ classifications: [{ index: 1, spam: true }, { index: 2, spam: false }] });
    expect(parseEmailScanResponse(text)).toEqual([
      { index: 1, spam: true },
      { index: 2, spam: false },
    ]);
  });

  it('returns an empty list for an empty classifications array', () => {
    expect(parseEmailScanResponse('{"classifications":[]}')).toEqual([]);
  });

  it('throws on non-JSON instead of silently dropping the scan', () => {
    expect(() => parseEmailScanResponse('Here is the JSON: [')).toThrow();
  });

  it('throws when the classifications key is missing or not an array', () => {
    expect(() => parseEmailScanResponse('[]')).toThrow(/classifications/);
    expect(() => parseEmailScanResponse('{"classifications":{}}')).toThrow(/classifications/);
  });

  it('throws on a row with a non-integer index or non-boolean spam', () => {
    expect(() => parseEmailScanResponse('{"classifications":[{"index":"1","spam":true}]}')).toThrow(/position 0/);
    expect(() => parseEmailScanResponse('{"classifications":[{"index":1,"spam":true},{"index":2,"spam":"yes"}]}')).toThrow(/position 1/);
  });
});

describe('CLEANUP_OUTPUT_FORMAT (MCS-6)', () => {
  it('is a strict json_schema with a required archive array of integers (1-based rule in prose, not minimum)', () => {
    expect(CLEANUP_OUTPUT_FORMAT.type).toBe('json_schema');
    const root = CLEANUP_OUTPUT_FORMAT.schema as any;
    expect(root.additionalProperties).toBe(false);
    expect(root.required).toEqual(['archive']);
    expect(root.properties.archive.type).toBe('array');
    expect(root.properties.archive.items.type).toBe('integer');
    expect(root.properties.archive.items.description).toMatch(/1-based/);
    expect(root.properties.archive.items).not.toHaveProperty('minimum');
  });

  it('system prompt describes the task without JSON-format scaffolding', () => {
    expect(CLEANUP_SYSTEM_PROMPT).toContain('1-based numbers');
    expect(CLEANUP_SYSTEM_PROMPT).toContain('empty list if none');
    expect(CLEANUP_SYSTEM_PROMPT).not.toContain('Return ONLY');
    expect(CLEANUP_SYSTEM_PROMPT).not.toContain('Example:');
  });
});

describe('parseCleanupResponse', () => {
  it('returns the archive numbers', () => {
    expect(parseCleanupResponse('{"archive":[1,3,5,8]}')).toEqual([1, 3, 5, 8]);
  });

  it('returns an empty list when nothing should be archived', () => {
    expect(parseCleanupResponse('{"archive":[]}')).toEqual([]);
  });

  it('throws on non-JSON, a missing archive key, or a bare array', () => {
    expect(() => parseCleanupResponse('none')).toThrow();
    expect(() => parseCleanupResponse('{}')).toThrow(/archive/);
    expect(() => parseCleanupResponse('[1,2]')).toThrow(/archive/);
  });

  it('throws on zero, negative, or non-integer numbers (1-based contract)', () => {
    expect(() => parseCleanupResponse('{"archive":[0]}')).toThrow(/position 0/);
    expect(() => parseCleanupResponse('{"archive":[2,-1]}')).toThrow(/position 1/);
    expect(() => parseCleanupResponse('{"archive":[1.5]}')).toThrow(/position 0/);
  });
});
