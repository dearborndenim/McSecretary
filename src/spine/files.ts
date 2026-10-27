/**
 * The spine file drop: `POST /spine/files` takes one file as the raw request
 * body (Content-Type = the file's type, `?name=<filename>`), stores it on the
 * volume under a random id and answers `{file_id, url, sha256, bytes,
 * content_type, expires_at}`; `GET /spine/files/<id>` serves it back to any
 * keyed agent. Events then carry the `file_id`. Files expire after 30 days and
 * are pruned on upload (the briefing-audit pattern: prune on write).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';

export const FILE_MAX_BYTES = 25 * 1024 * 1024;
export const FILE_RETENTION_DAYS = 30;
/** Every agent's hourly upload cap unless its AGENT_POLICY `rate.files_per_hour` says otherwise. */
export const DEFAULT_FILES_PER_HOUR = 60;
export const FILE_ID_RE = /^[a-f0-9]{32}$/;
const NAME_MAX = 120;

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const EXACT_TYPES = new Set(['application/pdf', 'text/csv', XLSX, 'application/zip', 'application/x-zip-compressed']);
/** For a client that sends application/octet-stream: the type comes from `?name=`'s extension. */
const EXT_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
  '.heic': 'image/heic', '.heif': 'image/heif', '.pdf': 'application/pdf', '.csv': 'text/csv', '.xlsx': XLSX,
  '.zip': 'application/zip',
};

/** Where uploads live: `SPINE_FILES_DIR`, else `spine-files/` beside the SQLite file (the Railway volume). */
export function spineFilesDir(env: Record<string, string | undefined>): string {
  if (env.SPINE_FILES_DIR) return env.SPINE_FILES_DIR;
  return path.join(path.dirname(env.DB_PATH || '/data/secretary.db'), 'spine-files');
}

/**
 * The stored content type, or null when the type is not accepted. Parameters
 * (`; charset=…`) are dropped. image/* is accepted except SVG (script-capable).
 * application/octet-stream falls back to the name's extension.
 */
export function acceptedContentType(header: string | undefined, name: string): string | null {
  const t = (header ?? '').split(';')[0]!.trim().toLowerCase();
  if (EXACT_TYPES.has(t)) return t;
  if (/^image\/[a-z0-9.+-]+$/.test(t) && t !== 'image/svg+xml') return t;
  if (t === 'application/octet-stream') return EXT_TYPES[path.extname(name).toLowerCase()] ?? null;
  return null;
}

/** A display name safe for a Content-Disposition header; the bytes on disk are named by id only. */
export function cleanFileName(raw: string): string {
  const base = path.basename(raw.replace(/\\/g, '/')).replace(/[^A-Za-z0-9._ -]/g, '_').trim().slice(0, NAME_MAX);
  return base.replace(/^\.+/, '') || 'file';
}

export interface SpineFileRow {
  id: string;
  name: string;
  content_type: string;
  bytes: number;
  sha256: string;
  uploaded_by: string;
  source: string | null;
  created_at: string;
  expires_at: string;
}

export function countFilesSince(db: Database.Database, agent: string, sinceIso: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM spine_files WHERE uploaded_by = ? AND created_at >= ?')
    .get(agent, sinceIso) as { n: number }).n;
}

export function getSpineFile(db: Database.Database, id: string): SpineFileRow | undefined {
  return db.prepare('SELECT * FROM spine_files WHERE id = ?').get(id) as SpineFileRow | undefined;
}

/** Delete every expired row and its bytes. A missing file on disk is not an error. Returns the count. */
export function pruneExpiredFiles(db: Database.Database, dir: string, nowIso: string): number {
  const expired = db.prepare('SELECT id FROM spine_files WHERE expires_at <= ?').all(nowIso) as { id: string }[];
  for (const { id } of expired) {
    try { fs.rmSync(path.join(dir, id), { force: true }); } catch (err) { console.error('spine files: prune failed', id, err); continue; }
    db.prepare('DELETE FROM spine_files WHERE id = ?').run(id);
  }
  return expired.length;
}

/** Write the bytes (temp file + rename) and the index row. */
export function storeSpineFile(
  db: Database.Database, dir: string,
  input: { name: string; content_type: string; bytes: Buffer; uploaded_by: string; source: string | null },
  nowIso: string,
): SpineFileRow {
  const id = crypto.randomBytes(16).toString('hex');
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${id}.tmp`);
  fs.writeFileSync(tmp, input.bytes);
  fs.renameSync(tmp, path.join(dir, id));
  const row: SpineFileRow = {
    id,
    name: input.name,
    content_type: input.content_type,
    bytes: input.bytes.length,
    sha256: crypto.createHash('sha256').update(input.bytes).digest('hex'),
    uploaded_by: input.uploaded_by,
    source: input.source,
    created_at: nowIso,
    expires_at: new Date(Date.parse(nowIso) + FILE_RETENTION_DAYS * 86_400_000).toISOString(),
  };
  db.prepare(`INSERT INTO spine_files (id, name, content_type, bytes, sha256, uploaded_by, source, created_at, expires_at)
    VALUES (@id, @name, @content_type, @bytes, @sha256, @uploaded_by, @source, @created_at, @expires_at)`).run(row);
  return row;
}
