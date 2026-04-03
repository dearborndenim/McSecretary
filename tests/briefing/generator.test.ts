import { describe, it, expect } from 'vitest';
import { buildBriefingPrompt } from '../../src/briefing/generator.js';
import type { ClassifiedEmail } from '../../src/email/types.js';

function makeClassified(overrides: Partial<ClassifiedEmail>): ClassifiedEmail {
  return {
    id: 'msg-1',
    account: 'rob@dearborndenim.com',
    sender: 'test@example.com',
    senderName: 'Test',
    subject: 'Test Subject',
    bodyPreview: 'Test body',
    body: 'Test body content',
    receivedAt: '2026-04-03T05:00:00Z',
    threadId: 'thread-1',
    isRead: false,
    category: 'customer_inquiry',
    urgency: 'high',
    actionNeeded: 'reply_required',
    confidence: 0.95,
    summary: 'Customer asking about bulk order',
    suggestedAction: 'Draft reply with pricing',
    senderImportance: 'new_customer',
    ...overrides,
  };
}

describe('buildBriefingPrompt', () => {
  it('groups emails by urgency in the prompt', () => {
    const emails = [
      makeClassified({ id: '1', urgency: 'critical', summary: 'Urgent customer issue' }),
      makeClassified({ id: '2', urgency: 'low', category: 'newsletter', summary: 'Industry news' }),
      makeClassified({ id: '3', urgency: 'high', summary: 'Supplier pricing update' }),
    ];

    const prompt = buildBriefingPrompt(emails, {
      totalProcessed: 50,
      archived: 30,
      flaggedForReview: 20,
    });

    expect(prompt).toContain('Urgent customer issue');
    expect(prompt).toContain('Supplier pricing update');
    expect(prompt).toContain('50');
  });

  it('includes stats in the prompt', () => {
    const prompt = buildBriefingPrompt([], {
      totalProcessed: 10,
      archived: 8,
      flaggedForReview: 2,
    });

    expect(prompt).toContain('10');
    expect(prompt).toContain('8');
  });
});
