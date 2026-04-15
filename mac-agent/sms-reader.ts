/**
 * SMS/iMessage reader for Mac Mini.
 * Reads recent messages from chat.db and POSTs them to Railway.
 *
 * Run: npx tsx mac-agent/sms-reader.ts
 * Requires Full Disk Access for the terminal/node binary.
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// Load .env from project root if available
const PROJECT_ROOT = path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), '..');
const ENV_FILE = path.join(PROJECT_ROOT, '.env');
if (fs.existsSync(ENV_FILE)) {
  const envContent = fs.readFileSync(ENV_FILE, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

const DB_PATH = path.join(os.homedir(), 'Library', 'Messages', 'chat.db');
const STATE_FILE = path.join(os.homedir(), '.mcsecretary-sms-state.json');
const LOG_FILE = path.join(PROJECT_ROOT, 'logs', 'sms-reader.log');

// Railway endpoint — set via env or default
const RAILWAY_URL = process.env.MCSECRETARY_URL ?? '';
const API_SECRET = process.env.MCSECRETARY_API_SECRET ?? '';

// Retry config
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;

export interface SmsMessage {
  rowid: number;
  text: string | null;
  isFromMe: boolean;
  sender: string;
  service: string;
  groupName: string | null;
  date: string;
}

function ensureLogDir(): void {
  const logDir = path.dirname(LOG_FILE);
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
}

export function logToFile(level: 'INFO' | 'ERROR' | 'WARN', message: string): void {
  const timestamp = new Date().toISOString();
  const entry = `[${timestamp}] [${level}] ${message}\n`;
  try {
    ensureLogDir();
    fs.appendFileSync(LOG_FILE, entry, 'utf-8');
  } catch {
    process.stderr.write(`LOG_WRITE_FAILED: ${entry}`);
  }
  if (level === 'ERROR') {
    console.error(message);
  } else {
    console.log(message);
  }
}

export function loadLastRowId(): number {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      return state.lastRowId ?? 0;
    }
  } catch {}
  return 0;
}

export function saveLastRowId(rowId: number): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify({ lastRowId: rowId, updatedAt: new Date().toISOString() }), 'utf-8');
}

export function readNewMessages(): SmsMessage[] {
  const lastRowId = loadLastRowId();

  const db = new Database(DB_PATH, { readonly: true });

  try {
    const messages = db.prepare(`
      SELECT
        m.ROWID as rowid,
        m.text,
        m.is_from_me,
        h.id AS sender,
        h.service,
        c.display_name AS group_name,
        datetime((m.date / 1000000000) + 978307200, 'unixepoch', 'localtime') AS message_date
      FROM message m
      LEFT JOIN handle h ON m.handle_id = h.ROWID
      LEFT JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
      LEFT JOIN chat c ON cmj.chat_id = c.ROWID
      WHERE m.ROWID > ?
        AND m.text IS NOT NULL
        AND m.text != ''
      ORDER BY m.date ASC
      LIMIT 100
    `).all(lastRowId) as {
      rowid: number;
      text: string;
      is_from_me: number;
      sender: string;
      service: string;
      group_name: string | null;
      message_date: string;
    }[];

    return messages.map((m) => ({
      rowid: m.rowid,
      text: m.text,
      isFromMe: m.is_from_me === 1,
      sender: m.sender ?? 'unknown',
      service: m.service ?? 'iMessage',
      groupName: m.group_name,
      date: m.message_date,
    }));
  } finally {
    db.close();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function sendToRailway(messages: SmsMessage[], railwayUrl?: string, apiSecret?: string): Promise<void> {
  const url = railwayUrl ?? RAILWAY_URL;
  const secret = apiSecret ?? API_SECRET;

  if (!url) {
    logToFile('WARN', `${messages.length} new messages (no RAILWAY_URL set, printing locally)`);
    for (const m of messages) {
      const direction = m.isFromMe ? 'Rob →' : `${m.sender} →`;
      console.log(`  [${m.date}] ${direction} ${m.text?.slice(0, 100)}`);
    }
    return;
  }

  if (!secret) {
    logToFile('ERROR', 'MCSECRETARY_API_SECRET is not set — cannot authenticate with Railway. Set it in .env or plist.');
    throw new Error('MCSECRETARY_API_SECRET is not set');
  }

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(`${url}/api/sms`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${secret}`,
        },
        body: JSON.stringify({ messages }),
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Railway API error (${response.status}): ${text}`);
      }

      logToFile('INFO', `Sent ${messages.length} messages to Railway (attempt ${attempt}).`);
      return;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      logToFile('WARN', `Attempt ${attempt}/${MAX_RETRIES} failed: ${lastError.message}`);

      if (attempt < MAX_RETRIES) {
        const delay = RETRY_DELAY_MS * attempt;
        logToFile('INFO', `Retrying in ${delay}ms...`);
        await sleep(delay);
      }
    }
  }

  logToFile('ERROR', `All ${MAX_RETRIES} attempts failed. Last error: ${lastError?.message}`);
  throw lastError ?? new Error('All retry attempts failed');
}

async function main() {
  logToFile('INFO', 'McSecretary SMS Reader starting...');

  try {
    const messages = readNewMessages();

    if (messages.length === 0) {
      logToFile('INFO', 'No new messages.');
      return;
    }

    logToFile('INFO', `Found ${messages.length} new messages.`);
    await sendToRailway(messages);

    // Update state with the highest rowid
    const maxRowId = Math.max(...messages.map((m) => m.rowid));
    saveLastRowId(maxRowId);
    logToFile('INFO', `State updated. Last ROWID: ${maxRowId}`);
  } catch (err) {
    logToFile('ERROR', `SMS Reader error: ${err}`);
    process.exit(1);
  }
}

// Only run main() when executed directly (not when imported by tests)
const isDirectRun = process.argv[1]?.endsWith('sms-reader.ts') || process.argv[1]?.endsWith('sms-reader.js');
if (isDirectRun) {
  main();
}
