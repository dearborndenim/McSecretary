import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { generateEndOfDayReflection } from '../../src/journal/reflection.js';
import { initializeSchema } from '../../src/db/schema.js';
import { insertConversationMessage } from '../../src/db/conversation-queries.js';
import { ensureJournalDirs } from '../../src/journal/files.js';

const JOURNAL_DIR = path.join(process.cwd(), 'data', 'journal', 'secretary');

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  initializeSchema(db);
  // Seed a user for FK constraint
  db.prepare("INSERT INTO users (id, name, email, role) VALUES ('robert-mcmillan', 'Robert', 'rob@dd.com', 'admin')").run();
  return db;
}

function mockAnthropic() {
  return {
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'Test reflection content' }],
      }),
    },
  } as any;
}

describe('generateEndOfDayReflection', () => {
  const testDate = '9999-01-01';

  afterEach(() => {
    // Cleanup test files
    const suffixes = ['reflection', 'improvements', 'learnings'];
    for (const suffix of suffixes) {
      const filePath = path.join(JOURNAL_DIR, `${testDate}-${suffix}.md`);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
  });

  it('writes 3 files when conversation exists', async () => {
    const db = createTestDb();
    const anthropic = mockAnthropic();

    insertConversationMessage(db, 'robert-mcmillan', testDate, 'secretary', '[Morning Briefing] Good morning.');
    insertConversationMessage(db, 'robert-mcmillan', testDate, 'rob', 'Thanks, looks good.');
    insertConversationMessage(db, 'robert-mcmillan', testDate, 'secretary', 'Glad to help.');

    const result = await generateEndOfDayReflection(db, anthropic, testDate);

    expect(result).toBe('completed');
    expect(anthropic.messages.create).toHaveBeenCalledTimes(3); // reflection + improvements + learnings

    ensureJournalDirs();
    expect(fs.existsSync(path.join(JOURNAL_DIR, `${testDate}-reflection.md`))).toBe(true);
    expect(fs.existsSync(path.join(JOURNAL_DIR, `${testDate}-improvements.md`))).toBe(true);
    expect(fs.existsSync(path.join(JOURNAL_DIR, `${testDate}-learnings.md`))).toBe(true);

    db.close();
  });

  it('writes minimal reflection when only secretary messages exist', async () => {
    const db = createTestDb();
    const anthropic = mockAnthropic();

    // Only secretary messages (scheduled tasks ran, Rob didn't respond)
    insertConversationMessage(db, 'robert-mcmillan', testDate, 'secretary', '[Morning Briefing] Good morning.');
    insertConversationMessage(db, 'robert-mcmillan', testDate, 'secretary', 'Quick check — what did you work on?');

    const result = await generateEndOfDayReflection(db, anthropic, testDate);

    expect(result).toBe('completed');
    expect(anthropic.messages.create).toHaveBeenCalledTimes(3);

    // Verify the prompt mentions Rob didn't respond
    const firstCall = anthropic.messages.create.mock.calls[0]![1] ?? anthropic.messages.create.mock.calls[0]![0];
    const msgContent = firstCall.messages[0].content;
    expect(msgContent).toContain('Rob did not respond today');

    db.close();
  });

  it('skips cleanly when truly zero activity', async () => {
    const db = createTestDb();
    const anthropic = mockAnthropic();

    const result = await generateEndOfDayReflection(db, anthropic, testDate);

    expect(result).toBe('skipped');
    expect(anthropic.messages.create).not.toHaveBeenCalled();

    // No files should be written
    expect(fs.existsSync(path.join(JOURNAL_DIR, `${testDate}-reflection.md`))).toBe(false);
    expect(fs.existsSync(path.join(JOURNAL_DIR, `${testDate}-improvements.md`))).toBe(false);
    expect(fs.existsSync(path.join(JOURNAL_DIR, `${testDate}-learnings.md`))).toBe(false);

    db.close();
  });
});
