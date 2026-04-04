import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  ensureJournalDirs,
  writeSecretaryReflection,
  readSecretaryFile,
  writeMasterLearnings,
  readMasterLearnings,
  writeRobJournal,
  readRobJournal,
} from '../../src/journal/files.js';

const TEST_BASE = path.join(process.cwd(), 'data', 'journal');

describe('journal files', () => {
  it('creates directories', () => {
    ensureJournalDirs();
    expect(fs.existsSync(path.join(TEST_BASE, 'secretary'))).toBe(true);
    expect(fs.existsSync(path.join(TEST_BASE, 'rob'))).toBe(true);
  });

  it('writes and reads secretary reflection', () => {
    writeSecretaryReflection('2026-04-04-test', 'Test reflection content');
    const content = readSecretaryFile('2026-04-04-test', 'reflection');
    expect(content).toBe('Test reflection content');

    // Cleanup
    fs.unlinkSync(path.join(TEST_BASE, 'secretary', '2026-04-04-test-reflection.md'));
  });

  it('writes and reads master learnings', () => {
    const original = readMasterLearnings();
    writeMasterLearnings('Test master content');
    expect(readMasterLearnings()).toBe('Test master content');

    // Restore original
    if (original) {
      writeMasterLearnings(original);
    }
  });

  it('returns empty string for non-existent files', () => {
    expect(readSecretaryFile('9999-99-99', 'reflection')).toBe('');
    expect(readRobJournal('9999-99-99')).toBe('');
  });
});
