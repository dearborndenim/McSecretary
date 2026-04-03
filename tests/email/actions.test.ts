import { describe, it, expect } from 'vitest';
import { determineAction, type EmailAction } from '../../src/email/actions.js';
import type { ClassifiedEmail } from '../../src/email/types.js';

function makeClassified(overrides: Partial<ClassifiedEmail>): ClassifiedEmail {
  return {
    id: 'msg-1',
    account: 'rob@dearborndenim.com',
    sender: 'test@example.com',
    senderName: 'Test',
    subject: 'Test',
    bodyPreview: 'Test',
    body: 'Test',
    receivedAt: '2026-04-03T05:00:00Z',
    threadId: 'thread-1',
    isRead: false,
    category: 'customer_inquiry',
    urgency: 'high',
    actionNeeded: 'reply_required',
    confidence: 0.95,
    summary: 'Test email',
    suggestedAction: 'Reply',
    senderImportance: 'new_customer',
    ...overrides,
  };
}

describe('determineAction', () => {
  it('archives junk with high confidence', () => {
    const email = makeClassified({ category: 'junk', confidence: 0.96 });
    const action = determineAction(email);
    expect(action.type).toBe('archive');
  });

  it('archives newsletters/promotional', () => {
    const email = makeClassified({ category: 'newsletter', actionNeeded: 'archive' });
    const action = determineAction(email);
    expect(action.type).toBe('archive');
  });

  it('flags customer inquiries for review', () => {
    const email = makeClassified({ category: 'customer_inquiry', urgency: 'high' });
    const action = determineAction(email);
    expect(action.type).toBe('flag_for_review');
  });

  it('marks transactional as read only', () => {
    const email = makeClassified({ category: 'transactional', actionNeeded: 'fyi_only' });
    const action = determineAction(email);
    expect(action.type).toBe('mark_read');
  });

  it('does not archive low-confidence junk', () => {
    const email = makeClassified({ category: 'junk', confidence: 0.6 });
    const action = determineAction(email);
    expect(action.type).toBe('flag_for_review');
  });
});
