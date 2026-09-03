import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { create: (...args: unknown[]) => mockCreate(...args) };
  },
}));
vi.mock('../../src/config.js', () => ({
  config: { anthropic: { apiKey: 'test-key' } },
}));

import {
  buildClassificationPrompt,
  parseClassificationResponse,
  classifyEmail,
  CLASSIFICATION_OUTPUT_FORMAT,
  CLASSIFICATION_CATEGORIES,
  CLASSIFICATION_URGENCIES,
  CLASSIFICATION_ACTIONS,
  CLASSIFICATION_SENDER_IMPORTANCE,
  SYSTEM_PROMPT,
} from '../../src/email/classifier.js';
import type { RawEmail } from '../../src/email/types.js';

const sampleEmail: RawEmail = {
  id: 'msg-1',
  account: 'rob@dearborndenim.com',
  sender: 'alice@fabricco.com',
  senderName: 'Alice Johnson',
  subject: 'Sample fabric pricing for fall collection',
  bodyPreview: 'Hi Rob, here are the prices for the denim rolls...',
  body: 'Hi Rob,\n\nHere are the prices for the denim rolls we discussed:\n- 12oz selvedge: $4.50/yard\n- 10oz stretch: $3.80/yard\n\nLet me know if you want to proceed with an order.\n\nBest,\nAlice',
  receivedAt: '2026-04-03T14:00:00Z',
  threadId: 'thread-1',
  isRead: false,
};

const validClassification = {
  category: 'supplier',
  urgency: 'medium',
  action_needed: 'review_required',
  confidence: 0.91,
  summary: 'Fabric supplier sending pricing for denim rolls',
  suggested_action: 'Review pricing and compare to current supplier rates',
  sender_importance: 'vendor',
};

beforeEach(() => {
  mockCreate.mockReset();
});

describe('buildClassificationPrompt', () => {
  it('includes sender, subject, and body in the prompt', () => {
    const prompt = buildClassificationPrompt(sampleEmail);
    expect(prompt).toContain('alice@fabricco.com');
    expect(prompt).toContain('Sample fabric pricing');
    expect(prompt).toContain('12oz selvedge');
  });

  it('includes the account info', () => {
    const prompt = buildClassificationPrompt(sampleEmail);
    expect(prompt).toContain('rob@dearborndenim.com');
  });
});

describe('CLASSIFICATION_OUTPUT_FORMAT (MCS-5)', () => {
  const schema = CLASSIFICATION_OUTPUT_FORMAT.schema as any;

  it('is a closed object requiring every classification field', () => {
    expect(CLASSIFICATION_OUTPUT_FORMAT.type).toBe('json_schema');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual([
      'category',
      'urgency',
      'action_needed',
      'confidence',
      'summary',
      'suggested_action',
      'sender_importance',
    ]);
    expect(Object.keys(schema.properties).sort()).toEqual([...schema.required].sort());
  });

  it('uses real enum arrays for the labelled fields', () => {
    expect(schema.properties.category.enum).toEqual([...CLASSIFICATION_CATEGORIES]);
    expect(schema.properties.urgency.enum).toEqual([...CLASSIFICATION_URGENCIES]);
    expect(schema.properties.action_needed.enum).toEqual([...CLASSIFICATION_ACTIONS]);
    expect(schema.properties.sender_importance.enum).toEqual([...CLASSIFICATION_SENDER_IMPORTANCE]);
    expect(CLASSIFICATION_CATEGORIES).toContain('junk');
    expect(CLASSIFICATION_CATEGORIES).toContain('customer_inquiry');
    expect(CLASSIFICATION_CATEGORIES).toHaveLength(10);
  });

  it('describes the confidence range in prose (live API rejects minimum/maximum)', () => {
    expect(schema.properties.confidence.type).toBe('number');
    expect(schema.properties.confidence.description).toMatch(/0.*1/);
    expect(schema.properties.confidence).not.toHaveProperty('minimum');
    expect(schema.properties.confidence).not.toHaveProperty('maximum');
  });

  it('system prompt keeps the category guidance and drops the JSON template scaffold', () => {
    expect(SYSTEM_PROMPT).toContain('Your job is to classify incoming emails.');
    expect(SYSTEM_PROMPT).toContain('Category guidance:');
    expect(SYSTEM_PROMPT).toContain('junk: Spam, phishing');
    expect(SYSTEM_PROMPT).not.toContain('Respond with ONLY');
    expect(SYSTEM_PROMPT).not.toContain('no markdown');
    expect(SYSTEM_PROMPT).not.toContain('"category":');
    expect(SYSTEM_PROMPT).not.toContain('0.0-1.0');
  });
});

describe('parseClassificationResponse', () => {
  it('parses a conforming JSON classification', () => {
    const result = parseClassificationResponse(JSON.stringify(validClassification));
    expect(result).toEqual(validClassification);
  });

  it('throws on non-JSON instead of returning a silent unknown', () => {
    expect(() => parseClassificationResponse('this is not json')).toThrow();
  });

  it('no longer strips markdown fences (the API returns bare JSON)', () => {
    const fenced = '```json\n' + JSON.stringify(validClassification) + '\n```';
    expect(() => parseClassificationResponse(fenced)).toThrow();
  });

  it('throws when a required field is missing', () => {
    const { summary: _omit, ...partial } = validClassification;
    expect(() => parseClassificationResponse(JSON.stringify(partial))).toThrow(/missing "summary"/);
  });

  it('clamps out-of-range confidence into [0, 1] at the boundary', () => {
    expect(parseClassificationResponse(JSON.stringify({ ...validClassification, confidence: 1.4 })).confidence).toBe(1);
    expect(parseClassificationResponse(JSON.stringify({ ...validClassification, confidence: -0.2 })).confidence).toBe(0);
    expect(parseClassificationResponse(JSON.stringify({ ...validClassification, confidence: 0.5 })).confidence).toBe(0.5);
  });

  it('throws when confidence is not a number, or the payload is an array', () => {
    expect(() =>
      parseClassificationResponse(JSON.stringify({ ...validClassification, confidence: '0.9' })),
    ).toThrow(/confidence/);
    expect(() => parseClassificationResponse('[1]')).toThrow(/not an object/);
  });
});

describe('classifyEmail request/response (MCS-5)', () => {
  it('sends output_config.format with the classification schema and no JSON prose', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify(validClassification) }],
    });

    const result = await classifyEmail(sampleEmail);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const req = mockCreate.mock.calls[0]![0] as any;
    expect(req.model).toBe('claude-haiku-4-5-20251001');
    expect(req.output_config).toEqual({ format: CLASSIFICATION_OUTPUT_FORMAT });
    expect(req.system).toBe(SYSTEM_PROMPT);
    expect(req.messages).toEqual([{ role: 'user', content: buildClassificationPrompt(sampleEmail) }]);

    expect(result).toMatchObject({
      id: 'msg-1',
      category: 'supplier',
      urgency: 'medium',
      actionNeeded: 'review_required',
      confidence: 0.91,
      summary: validClassification.summary,
      suggestedAction: validClassification.suggested_action,
      senderImportance: 'vendor',
    });
  });

  it('joins multiple text blocks before parsing', async () => {
    const json = JSON.stringify(validClassification);
    mockCreate.mockResolvedValue({
      content: [
        { type: 'text', text: json.slice(0, 20) },
        { type: 'text', text: json.slice(20) },
      ],
    });
    const result = await classifyEmail(sampleEmail);
    expect(result.category).toBe('supplier');
  });

  it('propagates API errors to the caller (triage skips the email; no silent unknown row)', async () => {
    mockCreate.mockRejectedValue(new Error('529 overloaded'));
    await expect(classifyEmail(sampleEmail)).rejects.toThrow('529 overloaded');
  });
});
