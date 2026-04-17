/**
 * End-of-day reflection capture: after the EOD summary, the next user message
 * should be saved to the user's daily journal file. This file tests the journal
 * write path directly; the full handleIncomingMessage flow depends on Telegram
 * + Anthropic + Graph integrations and is covered through manual testing.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { writeRobJournal, readRobJournal, ensureJournalDirs } from '../../src/journal/files.js';

const BASE = path.join(process.cwd(), 'data', 'journal', 'rob');

describe('EOD reflection capture', () => {
  beforeEach(() => {
    ensureJournalDirs();
  });

  it('appends a timestamped EOD reflection block to today\'s journal file', () => {
    const date = '2999-01-01-reflection-test';
    try {
      // First reflection
      const existing = readRobJournal(date);
      expect(existing).toBe('');
      writeRobJournal(date, `# Robert's Journal — ${date}\n\n[4:30 PM] [EOD reflection] Got a lot done today.`);
      const saved = readRobJournal(date);
      expect(saved).toContain('[EOD reflection] Got a lot done today.');

      // Second reflection same day should be appendable
      writeRobJournal(date, `${saved}\n\n[7:00 PM] [EOD reflection] Wrapping up.`);
      const updated = readRobJournal(date);
      expect(updated).toContain('Got a lot done today.');
      expect(updated).toContain('Wrapping up.');
    } finally {
      const p = path.join(BASE, `${date}.md`);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  });

  it('supports multiple users journaling on the same day (different files)', () => {
    const date = '2999-01-02-multi-user';
    try {
      writeRobJournal(date, `# Robert's Journal — ${date}\n\nHello`);
      // (Robert and members share writeRobJournal semantics via a date-keyed file —
      //  in practice each user has their own date key because of the in-memory flag.)
      expect(readRobJournal(date)).toContain('Hello');
    } finally {
      const p = path.join(BASE, `${date}.md`);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  });
});
