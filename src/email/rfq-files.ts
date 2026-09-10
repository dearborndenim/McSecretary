/**
 * Storage and public serving for the swatch photos and spec sheets vendors
 * attach to an RFQ reply.
 *
 * design-module has no asset-upload route and its `/files/...` endpoint is
 * bearer-gated, so McSecretary keeps these itself on the Railway volume and
 * serves them from `GET /files/rfq/<storage_id>/<name>` with no auth: the
 * gallery renders them in an `<img>`, and product-dev only stores the URL.
 * `storage_id` is 32 random hex chars minted per reply — the path is the
 * capability, so nothing is enumerable and nothing outside a reply we already
 * matched to an RFQ ever gets written here.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type http from 'node:http';

export const STORAGE_ID_RE = /^[a-f0-9]{32}$/;
export const STORED_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

const TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.pdf': 'application/pdf', '.txt': 'text/plain', '.csv': 'text/csv',
};

export function newStorageId(): string {
  return crypto.randomBytes(16).toString('hex');
}

/** Where RFQ attachments live. Beside the SQLite file on the Railway volume unless told otherwise. */
export function rfqFilesDir(env: Record<string, string | undefined>): string {
  if (env.RFQ_FILES_DIR) return env.RFQ_FILES_DIR;
  return path.join(path.dirname(env.DB_PATH || '/data/secretary.db'), 'rfq-files');
}

/** Public origin for the `/files/rfq/...` URLs. Empty means "we cannot publish a URL" and attachments are skipped. */
export function rfqPublicBaseUrl(env: Record<string, string | undefined>): string {
  return (env.PUBLIC_BASE_URL || env.BASE_URL || '').replace(/\/+$/, '');
}

/**
 * A filename safe to put on disk and in a URL: the vendor supplied it, so the
 * path separators, dot-segments and everything non-portable come out. A name
 * that reduces to nothing gets a generic one.
 */
export function safeFileName(name: string, fallback = 'attachment'): string {
  const base = path.basename(String(name ?? '')).replace(/[^A-Za-z0-9._-]/g, '_').replace(/^[._-]+/, '');
  const trimmed = base.slice(0, 120);
  return STORED_NAME_RE.test(trimmed) ? trimmed : fallback;
}

export function contentTypeForName(name: string): string {
  return TYPES[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
}

/** Write one attachment and return the path segment pair the URL is built from. */
export function writeRfqFile(dir: string, storageId: string, name: string, bytes: Buffer): string {
  const safe = safeFileName(name);
  const target = path.join(dir, storageId);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, safe), bytes);
  return safe;
}

export function rfqFileUrl(baseUrl: string, storageId: string, name: string): string {
  return `${baseUrl}/files/rfq/${storageId}/${encodeURIComponent(name)}`;
}

export interface RfqFilesRouterDeps {
  dir: string;
}

/**
 * `GET /files/rfq/<storage_id>/<name>` — public, cacheable, read-only.
 * Returns true when it answered so `src/api.ts` stops; false for any other
 * path. Both segments are checked against a strict allowlist and the resolved
 * file must stay inside the store, so a crafted URL cannot walk the volume.
 */
export function createRfqFilesRouter(deps: RfqFilesRouterDeps) {
  return async function handleRfqFileRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<boolean> {
    const url = req.url ?? '';
    if (!url.startsWith('/files/rfq/')) return false;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return true;
    }

    const [pathname] = url.split('?', 1) as [string];
    const parts = pathname.split('/').filter((p) => p.length > 0); // ['files','rfq',id,name]
    const notFound = (): true => {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return true;
    };
    if (parts.length !== 4) return notFound();

    const storageId = parts[2]!;
    let name: string;
    try {
      name = decodeURIComponent(parts[3]!);
    } catch {
      return notFound();
    }
    if (!STORAGE_ID_RE.test(storageId) || !STORED_NAME_RE.test(name)) return notFound();

    const root = path.resolve(deps.dir);
    const file = path.resolve(root, storageId, name);
    if (file !== path.join(root, storageId, name)) return notFound();

    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(file);
    } catch {
      return notFound();
    }

    res.writeHead(200, {
      'Content-Type': contentTypeForName(name),
      'Content-Length': String(bytes.byteLength),
      'Cache-Control': 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `inline; filename="${name}"`,
    });
    if (req.method === 'HEAD') res.end();
    else res.end(bytes);
    return true;
  };
}
