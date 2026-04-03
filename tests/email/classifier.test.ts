import { describe, it, expect } from 'vitest';
import { buildClassificationPrompt, parseClassificationResponse } from '../../src/email/classifier.js';
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

describe('parseClassificationResponse', () => {
  it('parses valid JSON classification', () => {
    const raw = JSON.stringify({
      category: 'supplier',
      urgency: 'medium',
      action_needed: 'review_required',
      confidence: 0.91,
      summary: 'Fabric supplier sending pricing for denim rolls',
      suggested_action: 'Review pricing and compare to current supplier rates',
      sender_importance: 'vendor',
    });

    const result = parseClassificationResponse(raw);
    expect(result.category).toBe('supplier');
    expect(result.urgency).toBe('medium');
    expect(result.confidence).toBe(0.91);
  });

  it('handles JSON wrapped in markdown code fences', () => {
    const raw = '```json\n{"category":"junk","urgency":"low","action_needed":"archive","confidence":0.98,"summary":"Spam","suggested_action":"Archive","sender_importance":"unknown"}\n```';
    const result = parseClassificationResponse(raw);
    expect(result.category).toBe('junk');
  });

  it('returns fallback for unparseable response', () => {
    const result = parseClassificationResponse('this is not json');
    expect(result.category).toBe('unknown');
    expect(result.confidence).toBe(0);
  });
});
