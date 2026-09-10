import { describe, it, expect } from 'vitest';
import { CLASSIFICATION_OUTPUT_FORMAT } from '../../src/email/classifier.js';
import { EMAIL_SCAN_OUTPUT_FORMAT, CLEANUP_OUTPUT_FORMAT } from '../../src/email/scan-schemas.js';
import { RFQ_EXTRACTION_OUTPUT_FORMAT } from '../../src/email/rfq-intake.js';

/**
 * Live probe (2026-09-03): the structured-outputs endpoint rejects `minimum`,
 * `maximum`, `oneOf`, `minItems`/`maxItems` above 1, and `enum` combined with
 * a nullable type union. Mocked tests cannot catch that, so this guard walks
 * every exported schema and fails on the unsupported keywords.
 */
const UNSUPPORTED_KEYWORDS = ['minimum', 'maximum', 'oneOf'];

function collectKeys(node: unknown, path: string, out: string[]): void {
  if (Array.isArray(node)) {
    node.forEach((child, i) => collectKeys(child, `${path}[${i}]`, out));
    return;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (UNSUPPORTED_KEYWORDS.includes(key)) out.push(`${path}.${key}`);
      if ((key === 'minItems' || key === 'maxItems') && typeof value === 'number' && value > 1) {
        out.push(`${path}.${key}>1`);
      }
      if (key === 'enum' && Array.isArray((node as Record<string, unknown>).type)) {
        out.push(`${path}.enum+type-union`);
      }
      if (key === 'enum' && Array.isArray(value) && value.includes(null)) {
        out.push(`${path}.enum-with-null`);
      }
      collectKeys(value, `${path}.${key}`, out);
    }
  }
}

const SCHEMAS = {
  CLASSIFICATION_OUTPUT_FORMAT,
  EMAIL_SCAN_OUTPUT_FORMAT,
  CLEANUP_OUTPUT_FORMAT,
  RFQ_EXTRACTION_OUTPUT_FORMAT,
};

describe('structured-output schemas use only API-supported keywords', () => {
  for (const [name, format] of Object.entries(SCHEMAS)) {
    it(`${name} has no minimum/maximum/oneOf, minItems/maxItems>1, or enum+nullable-union`, () => {
      expect(format.type).toBe('json_schema');
      const offenders: string[] = [];
      collectKeys(format.schema, name, offenders);
      expect(offenders).toEqual([]);
    });

    it(`${name}: every object node is closed and lists its required keys`, () => {
      const problems: string[] = [];
      const walk = (node: unknown, path: string): void => {
        if (Array.isArray(node)) {
          node.forEach((c, i) => walk(c, `${path}[${i}]`));
          return;
        }
        if (node && typeof node === 'object') {
          const obj = node as Record<string, unknown>;
          if (obj.type === 'object') {
            if (obj.additionalProperties !== false) problems.push(`${path}: additionalProperties`);
            const props = Object.keys((obj.properties as Record<string, unknown>) ?? {});
            const required = (obj.required as string[]) ?? [];
            if ([...props].sort().join() !== [...required].sort().join()) {
              problems.push(`${path}: required ${required.join(',')} != properties ${props.join(',')}`);
            }
          }
          for (const [k, v] of Object.entries(obj)) walk(v, `${path}.${k}`);
        }
      };
      walk(format.schema, name);
      expect(problems).toEqual([]);
    });
  }
});
