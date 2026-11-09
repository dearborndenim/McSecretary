import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { determineAction, ensureFolder, folderIdFromList, type EmailAction } from '../../src/email/actions.js';
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

describe('inbox sweep folders (Graph mailFolders fixture)', () => {
  const folders = JSON.parse(readFileSync(new URL('../fixtures/inbox-sweep/mail-folders.json', import.meta.url), 'utf8'));

  it('finds a top-level folder by display name, case-insensitively', () => {
    expect(folderIdFromList(folders, 'Promotions')).toBe('AAMkAD-fld-promo');
    expect(folderIdFromList(folders, 'dmarc reports')).toBe('AAMkAD-fld-dmarc');
    expect(folderIdFromList(folders, 'Gov Bids')).toBeNull();
  });

  it('refuses a response without a value array', () => {
    expect(() => folderIdFromList({ error: { code: 'ErrorAccessDenied' } }, 'Promotions')).toThrow(/value array/);
  });

  function graph(createdId: string) {
    return (async (_url: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') return new Response(JSON.stringify(folders), { status: 200 });
      return new Response(JSON.stringify({ id: createdId, displayName: JSON.parse(String(init!.body)).displayName }), { status: 201 });
    }) as typeof fetch;
  }

  it('returns an existing folder id, creates a missing one, and passes well-known names through', async () => {
    const deps = { fetch: graph('AAMkAD-fld-new'), token: async () => 't' };
    expect(await ensureFolder('rob@dearborndenim.com', 'Promotions', deps)).toBe('AAMkAD-fld-promo');
    expect(await ensureFolder('rob@dearborndenim.com', 'Gov Bids', deps)).toBe('AAMkAD-fld-new');
    expect(await ensureFolder('rob@dearborndenim.com', 'junkemail', deps)).toBe('junkemail');
  });
});
