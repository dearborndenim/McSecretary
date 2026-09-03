/**
 * Structured-output schemas + boundary parsers for the two inbox scans in
 * src/index.ts (prompt audit MCS-4 email scan, MCS-6 cleanup scan).
 *
 * The API guarantees the response text conforms to the schema, so parsing is a
 * plain JSON.parse; the parsers below only re-check the shape at the boundary
 * so a malformed payload fails loudly instead of silently mis-tagging mail.
 */

import type Anthropic from '@anthropic-ai/sdk';

/** MCS-4: 30-minute spam scan over every user's untagged mail. */
export const EMAIL_SCAN_OUTPUT_FORMAT: Anthropic.Messages.JSONOutputFormat = {
  type: 'json_schema',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['classifications'],
    properties: {
      classifications: {
        type: 'array',
        description: 'One entry per email in the input list.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['index', 'spam'],
          properties: {
            index: { type: 'integer', description: 'The 1-based email number from the input list.' },
            spam: { type: 'boolean', description: 'true if the email should be tagged as spam.' },
          },
        },
      },
    },
  },
};

export interface EmailScanClassification {
  index: number;
  spam: boolean;
}

export function parseEmailScanResponse(text: string): EmailScanClassification[] {
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { classifications?: unknown }).classifications)) {
    throw new Error('Email scan: response missing classifications array');
  }
  const rows = (parsed as { classifications: unknown[] }).classifications;
  return rows.map((row, i) => {
    const r = row as { index?: unknown; spam?: unknown };
    if (!Number.isInteger(r.index) || typeof r.spam !== 'boolean') {
      throw new Error(`Email scan: malformed classification at position ${i}`);
    }
    return { index: r.index as number, spam: r.spam };
  });
}

/** MCS-6: on-demand "clean up email" scan; returns 1-based numbers to archive. */
export const CLEANUP_OUTPUT_FORMAT: Anthropic.Messages.JSONOutputFormat = {
  type: 'json_schema',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['archive'],
    properties: {
      archive: {
        type: 'array',
        description: '1-based numbers of the emails that should be archived; empty if none.',
        // The live API rejects minimum/maximum; the >= 1 rule is enforced in parseCleanupResponse.
        items: { type: 'integer', description: 'A 1-based email number from the input list.' },
      },
    },
  },
};

export const CLEANUP_SYSTEM_PROMPT =
  'You are an email triage assistant. Identify emails that are junk, newsletters, promotional, or transactional (not needing attention) and return their 1-based numbers; return an empty list if none should be archived.';

export function parseCleanupResponse(text: string): number[] {
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { archive?: unknown }).archive)) {
    throw new Error('Email cleanup: response missing archive array');
  }
  const rows = (parsed as { archive: unknown[] }).archive;
  return rows.map((n, i) => {
    if (!Number.isInteger(n) || (n as number) < 1) {
      throw new Error(`Email cleanup: malformed email number at position ${i}`);
    }
    return n as number;
  });
}
