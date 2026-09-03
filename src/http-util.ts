import type http from 'node:http';

export class BodyTooLarge extends Error {}

/**
 * Read a request body as UTF-8. Chunks are concatenated as bytes before
 * decoding, so a multi-byte character split across chunks survives. On
 * overflow reading stops and the promise rejects with BodyTooLarge; the caller
 * writes the 413 and destroys the socket once that response has flushed.
 */
export function readBody(req: http.IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    req.on('data', (c: Buffer | string) => {
      if (settled) return;
      const buf = typeof c === 'string' ? Buffer.from(c, 'utf8') : c;
      size += buf.length;
      if (size > maxBytes) {
        settled = true;
        req.pause();
        reject(new BodyTooLarge('Body too large'));
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}
