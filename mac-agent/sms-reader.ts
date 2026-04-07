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

const DB_PATH = path.join(os.homedir(), 'Library', 'Messages', 'chat.db');
const STATE_FILE = path.join(os.homedir(), '.mcsecretary-sms-state.json');

// Railway endpoint — set via env or default
const RAILWAY_URL = process.env.MCSECRETARY_URL ?? '';
const API_SECRET = process.env.MCSECRETARY_API_SECRET ?? '';

interface SmsMessage {
  rowid: number;
  text: string | null;
  isFromMe: boolean;
  sender: string;
  service: string;
  groupName: string | null;
  date: string;
}

function loadLastRowId(): number {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      return state.lastRowId ?? 0;
    }
  } catch {}
  return 0;
}

function saveLastRowId(rowId: number): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify({ lastRowId: rowId, updatedAt: new Date().toISOString() }), 'utf-8');
}

function readNewMessages(): SmsMessage[] {
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

async function sendToRailway(messages: SmsMessage[]): Promise<void> {
  if (!RAILWAY_URL) {
    // No Railway URL — just print locally
    console.log(`${messages.length} new messages (no RAILWAY_URL set, printing locally):`);
    for (const m of messages) {
      const direction = m.isFromMe ? 'Rob →' : `${m.sender} →`;
      console.log(`  [${m.date}] ${direction} ${m.text?.slice(0, 100)}`);
    }
    return;
  }

  const response = await fetch(`${RAILWAY_URL}/api/sms`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_SECRET}`,
    },
    body: JSON.stringify({ messages }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Railway API error (${response.status}): ${text}`);
  }

  console.log(`Sent ${messages.length} messages to Railway.`);
}

async function main() {
  console.log('McSecretary SMS Reader starting...');

  try {
    const messages = readNewMessages();

    if (messages.length === 0) {
      console.log('No new messages.');
      return;
    }

    console.log(`Found ${messages.length} new messages.`);
    await sendToRailway(messages);

    // Update state with the highest rowid
    const maxRowId = Math.max(...messages.map((m) => m.rowid));
    saveLastRowId(maxRowId);
    console.log(`State updated. Last ROWID: ${maxRowId}`);
  } catch (err) {
    console.error('SMS Reader error:', err);
    process.exit(1);
  }
}

main();
