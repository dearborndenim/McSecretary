/**
 * Serves the South Loop Lions team page with live data injected.
 *
 * The page is a static single-file artifact (`src/lions/page.html`) that works
 * on its own; the server only swaps the JSON inside its `<script
 * id="lions-data">` block. Railway runs `npx tsx src/index.ts`, so the file is
 * read from `src/` at runtime — there is no build step that would need to copy
 * it. The cwd fallback covers a compiled (`dist/`) start.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LionsGame } from './parse.js';
import type { LionsAlertRow } from './store.js';

export interface LionsPageData {
  games: LionsGame[];
  alerts: LionsAlertRow[];
  checkedAt: string | null;
  live: boolean;
}

const DATA_BLOCK_RE = /(<script id="lions-data" type="application\/json">)([\s\S]*?)(<\/script>)/;

let cached: string | null = null;

export function lionsPagePath(): string {
  const beside = fileURLToPath(new URL('./page.html', import.meta.url));
  if (fs.existsSync(beside)) return beside;
  return path.join(process.cwd(), 'src', 'lions', 'page.html');
}

export function loadLionsPageTemplate(reload = false): string {
  if (cached !== null && !reload) return cached;
  cached = fs.readFileSync(lionsPagePath(), 'utf8');
  return cached;
}

/**
 * Replace exactly the JSON inside the data block. `</` is escaped as `<\/` so a
 * CPS note or team name can never close the script element early. The block is
 * read with JSON.parse (not evaluated), so no other escaping is needed.
 */
export function injectLionsData(template: string, data: LionsPageData): string {
  const json = JSON.stringify(data).split('</').join('<\\/');
  if (!DATA_BLOCK_RE.test(template)) {
    throw new Error('lions page template is missing its <script id="lions-data"> block');
  }
  return template.replace(DATA_BLOCK_RE, (_all, open: string, _old: string, close: string) => `${open}${json}${close}`);
}

export function renderLionsPage(data: LionsPageData): string {
  return injectLionsData(loadLionsPageTemplate(), data);
}
