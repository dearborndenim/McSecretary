import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    env: {
      // A fresh temp dir per run. Railway sets JOURNAL_PATH=/data/journal in production; pointing
      // tests at the repo's data/journal made tests/journal/* overwrite the two TRACKED
      // master-*.md files (found 2026-09-03). ensureJournalDirs() stubs the masters on first use.
      JOURNAL_PATH: fs.mkdtempSync(path.join(os.tmpdir(), 'mcsecretary-journal-')),
    },
  },
});
