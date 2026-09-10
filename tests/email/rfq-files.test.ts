import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type http from 'node:http';
import {
  createRfqFilesRouter, newStorageId, rfqFileUrl, rfqFilesDir, rfqPublicBaseUrl,
  safeFileName, writeRfqFile, contentTypeForName, STORAGE_ID_RE,
} from '../../src/email/rfq-files.js';

describe('rfqFilesDir / rfqPublicBaseUrl', () => {
  it('puts the store beside the SQLite file by default', () => {
    expect(rfqFilesDir({})).toBe('/data/rfq-files');
    expect(rfqFilesDir({ DB_PATH: '/mnt/vol/secretary.db' })).toBe('/mnt/vol/rfq-files');
    expect(rfqFilesDir({ RFQ_FILES_DIR: '/custom' })).toBe('/custom');
  });

  it('prefers PUBLIC_BASE_URL, strips trailing slashes, and reports "no base" as empty', () => {
    expect(rfqPublicBaseUrl({ PUBLIC_BASE_URL: 'https://mcs.example/' })).toBe('https://mcs.example');
    expect(rfqPublicBaseUrl({ BASE_URL: 'https://fallback.example' })).toBe('https://fallback.example');
    expect(rfqPublicBaseUrl({})).toBe('');
  });
});

describe('safeFileName', () => {
  it.each([
    ['swatch.png', 'swatch.png'],
    ['../../etc/passwd', 'passwd'],
    ['dir/sub/spec sheet.pdf', 'spec_sheet.pdf'],
    ['..', 'attachment'],
    ['', 'attachment'],
    ['.hidden', 'hidden'],
  ])('%s → %s', (input, expected) => expect(safeFileName(input)).toBe(expected));

  it('truncates a very long name', () => {
    expect(safeFileName(`${'a'.repeat(300)}.png`).length).toBeLessThanOrEqual(120);
  });
});

describe('storage ids and URLs', () => {
  it('mints 32 unguessable hex chars', () => {
    const id = newStorageId();
    expect(id).toMatch(STORAGE_ID_RE);
    expect(newStorageId()).not.toBe(id);
  });

  it('builds a URL under /files/rfq/', () => {
    expect(rfqFileUrl('https://mcs.example', 'a'.repeat(32), 'sw ap.png'))
      .toBe(`https://mcs.example/files/rfq/${'a'.repeat(32)}/sw%20ap.png`);
  });
});

describe('contentTypeForName', () => {
  it.each([['a.png', 'image/png'], ['a.pdf', 'application/pdf'], ['a.bin', 'application/octet-stream']])(
    '%s → %s', (n, t) => expect(contentTypeForName(n)).toBe(t),
  );
});

interface FakeRes {
  status: number | null;
  headers: Record<string, string>;
  body: Buffer | string | null;
}

function fakeRes(): { res: http.ServerResponse; out: FakeRes } {
  const out: FakeRes = { status: null, headers: {}, body: null };
  const res = {
    writeHead(status: number, headers: Record<string, string>) { out.status = status; out.headers = headers ?? {}; },
    end(body?: Buffer | string) { out.body = body ?? null; },
  } as unknown as http.ServerResponse;
  return { res, out };
}

describe('createRfqFilesRouter', () => {
  let dir: string;
  let storageId: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfq-files-'));
    storageId = newStorageId();
    writeRfqFile(dir, storageId, 'swatch.png', Buffer.from('PNGDATA'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('ignores every path that is not /files/rfq/', async () => {
    const handle = createRfqFilesRouter({ dir });
    const { res } = fakeRes();
    expect(await handle({ url: '/health', method: 'GET' } as http.IncomingMessage, res)).toBe(false);
    expect(await handle({ url: '/files/other/x', method: 'GET' } as http.IncomingMessage, res)).toBe(false);
  });

  it('serves a stored attachment with no auth, typed and cacheable', async () => {
    const handle = createRfqFilesRouter({ dir });
    const { res, out } = fakeRes();
    const answered = await handle(
      { url: `/files/rfq/${storageId}/swatch.png`, method: 'GET', headers: {} } as http.IncomingMessage,
      res,
    );
    expect(answered).toBe(true);
    expect(out.status).toBe(200);
    expect(out.headers['Content-Type']).toBe('image/png');
    expect(out.headers['Cache-Control']).toBe('public, max-age=86400');
    expect(out.headers['X-Content-Type-Options']).toBe('nosniff');
    expect((out.body as Buffer).toString()).toBe('PNGDATA');
  });

  it('answers HEAD with the headers and no body', async () => {
    const handle = createRfqFilesRouter({ dir });
    const { res, out } = fakeRes();
    await handle({ url: `/files/rfq/${storageId}/swatch.png`, method: 'HEAD' } as http.IncomingMessage, res);
    expect(out.status).toBe(200);
    expect(out.body).toBeNull();
  });

  it('405s a write attempt — the store is read-only over HTTP', async () => {
    const handle = createRfqFilesRouter({ dir });
    const { res, out } = fakeRes();
    await handle({ url: `/files/rfq/${storageId}/swatch.png`, method: 'POST' } as http.IncomingMessage, res);
    expect(out.status).toBe(405);
  });

  it.each([
    ['a wrong storage id', `/files/rfq/${'b'.repeat(32)}/swatch.png`],
    ['a malformed storage id', '/files/rfq/short/swatch.png'],
    ['a missing file', null],
    ['a traversal in the name', null],
    ['an encoded traversal', null],
    ['a nested path', null],
  ])('404s %s', async (label, explicit) => {
    const handle = createRfqFilesRouter({ dir });
    const urls: Record<string, string> = {
      'a missing file': `/files/rfq/${storageId}/absent.png`,
      'a traversal in the name': `/files/rfq/${storageId}/../../etc/passwd`,
      'an encoded traversal': `/files/rfq/${storageId}/%2e%2e%2fpasswd`,
      'a nested path': `/files/rfq/${storageId}/sub/swatch.png`,
    };
    const { res, out } = fakeRes();
    await handle({ url: explicit ?? urls[label]!, method: 'GET' } as http.IncomingMessage, res);
    expect(out.status).toBe(404);
  });
});
