import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    env: {
      // Use local data/ dir when running tests — Railway sets JOURNAL_PATH=/data/journal in production
      JOURNAL_PATH: path.join(process.cwd(), 'data', 'journal'),
    },
  },
});
