/**
 * Simple HTTP API for receiving data from the Mac Mini agent.
 * Runs alongside the Telegram bot.
 */

import http from 'node:http';
import type Database from 'better-sqlite3';

let _db: Database.Database | null = null;
let _apiSecret: string = '';

export function initApi(db: Database.Database, apiSecret: string): void {
  _db = db;
  _apiSecret = apiSecret;
}

interface SmsMessage {
  rowid: number;
  text: string | null;
  isFromMe: boolean;
  sender: string;
  service: string;
  groupName: string | null;
  date: string;
}

function ensureDb(): Database.Database {
  if (!_db) throw new Error('API not initialized');
  return _db;
}

function handleSmsIngest(messages: SmsMessage[]): { stored: number } {
  const db = ensureDb();

  // Create table if not exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS sms_messages (
      rowid INTEGER PRIMARY KEY,
      text TEXT,
      is_from_me INTEGER,
      sender TEXT,
      service TEXT,
      group_name TEXT,
      message_date TEXT,
      ingested_at TEXT DEFAULT (datetime('now'))
    )
  `);

  const insert = db.prepare(`
    INSERT OR IGNORE INTO sms_messages (rowid, text, is_from_me, sender, service, group_name, message_date)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  let stored = 0;
  for (const m of messages) {
    const result = insert.run(m.rowid, m.text, m.isFromMe ? 1 : 0, m.sender, m.service, m.groupName, m.date);
    if (result.changes > 0) stored++;
  }

  return { stored };
}

export function getRecentSmsMessages(db: Database.Database, hours: number = 24, limit: number = 50): string {
  // Check if table exists
  const tableExists = db.prepare(`
    SELECT name FROM sqlite_master WHERE type='table' AND name='sms_messages'
  `).get();

  if (!tableExists) return 'No SMS data available yet.';

  const rows = db.prepare(`
    SELECT text, is_from_me, sender, group_name, message_date
    FROM sms_messages
    WHERE message_date >= datetime('now', '-${hours} hours')
    ORDER BY rowid DESC
    LIMIT ?
  `).all(limit) as {
    text: string;
    is_from_me: number;
    sender: string;
    group_name: string | null;
    message_date: string;
  }[];

  if (rows.length === 0) return 'No recent text messages.';

  return rows.reverse().map((m) => {
    const direction = m.is_from_me ? 'Rob' : m.sender;
    const group = m.group_name ? ` [${m.group_name}]` : '';
    return `[${m.message_date}]${group} ${direction}: ${m.text}`;
  }).join('\n');
}

export function startApiServer(port: number = 3000): http.Server {
  const server = http.createServer(async (req, res) => {
    // CORS + health check
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    // SMS ingest endpoint
    if (req.method === 'POST' && req.url === '/api/sms') {
      // Check auth
      const authHeader = req.headers.authorization;
      if (_apiSecret && authHeader !== `Bearer ${_apiSecret}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }

      try {
        const body = await readBody(req);
        const data = JSON.parse(body);
        const result = handleSmsIngest(data.messages ?? []);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: msg }));
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  server.listen(port, () => {
    console.log(`API server listening on port ${port}`);
  });

  return server;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}
