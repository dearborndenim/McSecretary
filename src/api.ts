/**
 * Simple HTTP API for receiving data from the Mac Mini agent.
 * Runs alongside the Telegram bot.
 */

import http from 'node:http';
import type Database from 'better-sqlite3';
import type { BriefingPreviewCache } from './briefing/preview-cache.js';

let _db: Database.Database | null = null;
let _apiSecret: string = '';
let _briefingPreviewCacheProvider: (() => BriefingPreviewCache | undefined) | null = null;

type SpineHttp = (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean>;
let _spineHttp: SpineHttp | null = null;
let _lionsHttp: SpineHttp | null = null;
let _rfqFilesHttp: SpineHttp | null = null;

/** Wired from src/index.ts. Handles /spine/* before the legacy routes. */
export function setSpineHttpHandler(handler: SpineHttp): void {
  _spineHttp = handler;
}

/** Wired from src/index.ts. Handles /lions and /lions/* (see src/lions/routes.ts). */
export function setLionsHttpHandler(handler: SpineHttp): void {
  _lionsHttp = handler;
}

/**
 * Wired from src/index.ts. Serves `/files/rfq/<storage_id>/<name>` — the
 * swatch photos vendors attach to an RFQ reply. Public and unauthenticated by
 * design: product-dev's gallery renders them in an `<img>`. The 32-hex
 * storage id is the capability (see src/email/rfq-files.ts).
 */
export function setRfqFilesHttpHandler(handler: SpineHttp): void {
  _rfqFilesHttp = handler;
}

export function initApi(db: Database.Database, apiSecret: string): void {
  _db = db;
  _apiSecret = apiSecret;
}

/**
 * Register a provider that returns the live `/briefing-preview` cache. Wired
 * from `src/index.ts` so the admin stats endpoint can read counters without
 * pulling the cache module at the top of `api.ts` (avoids circular imports).
 *
 * The provider may return `undefined` if the cache hasn't been built yet —
 * the endpoint reports `size:0, hits:0, misses:0` in that case.
 */
export function setBriefingPreviewCacheProvider(
  provider: () => BriefingPreviewCache | undefined,
): void {
  _briefingPreviewCacheProvider = provider;
}

/**
 * Render the JSON payload for `/admin/briefing-preview-cache-stats`. Pure —
 * accepts the cache directly so unit tests don't need the HTTP layer.
 *
 * Shape (Polish 8 — 2026-04-30):
 *   {
 *     size: number,
 *     ttl_seconds: number,
 *     hits: number,
 *     misses: number,
 *     oldest_entry_age_seconds: number | null,
 *     disabled: boolean
 *   }
 *
 * `disabled:true` when the cache is the no-op shim (DISABLE=1) OR when no
 * cache is wired yet. Counters/age default to `0` / `null` in that case.
 */
export function buildBriefingPreviewCacheStatsPayload(
  cache: BriefingPreviewCache | undefined,
): {
  size: number;
  ttl_seconds: number;
  hits: number;
  misses: number;
  oldest_entry_age_seconds: number | null;
  disabled: boolean;
} {
  if (!cache) {
    return {
      size: 0,
      ttl_seconds: 0,
      hits: 0,
      misses: 0,
      oldest_entry_age_seconds: null,
      disabled: true,
    };
  }
  const stats = cache.stats();
  return {
    size: cache.size(),
    ttl_seconds: cache.ttlSeconds,
    hits: stats.hits,
    misses: stats.misses,
    oldest_entry_age_seconds:
      stats.oldestEntryAgeMs === null ? null : Math.floor(stats.oldestEntryAgeMs / 1000),
    disabled: !cache.enabled,
  };
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
    WHERE message_date >= datetime('now', '-' || ? || ' hours')
    ORDER BY rowid DESC
    LIMIT ?
  `).all(hours, limit) as {
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
    if (_spineHttp && (req.url ?? '').startsWith('/spine/')) {
      if (await _spineHttp(req, res)) return;
    }

    if (_lionsHttp && (req.url ?? '').startsWith('/lions')) {
      if (await _lionsHttp(req, res)) return;
    }

    if (_rfqFilesHttp && (req.url ?? '').startsWith('/files/rfq/')) {
      if (await _rfqFilesHttp(req, res)) return;
    }

    // CORS + health check
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    // Admin: /briefing-preview cache stats (Polish 8 — 2026-04-30).
    // Bearer-gated using the same API_SECRET as /api/sms so we don't fork a
    // second auth surface. Returns counters + age/size + ttl + disabled flag.
    if (req.method === 'GET' && req.url === '/admin/briefing-preview-cache-stats') {
      if (!_apiSecret) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'API authentication not configured' }));
        return;
      }
      const authHeader = req.headers.authorization;
      if (authHeader !== `Bearer ${_apiSecret}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      const cache = _briefingPreviewCacheProvider ? _briefingPreviewCacheProvider() : undefined;
      const payload = buildBriefingPreviewCacheStatsPayload(cache);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
      return;
    }

    // SMS ingest endpoint
    if (req.method === 'POST' && req.url === '/api/sms') {
      // Check auth — fail closed when no secret is configured
      if (!_apiSecret) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'API authentication not configured' }));
        return;
      }
      const authHeader = req.headers.authorization;
      if (authHeader !== `Bearer ${_apiSecret}`) {
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

const MAX_BODY_SIZE = 1024 * 1024; // 1 MB

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    req.on('data', (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error('Request body too large (max 1MB)'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}
