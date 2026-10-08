/**
 * Staff admin UI auth (staff admin UI spec §2): one admin password, a signed
 * session cookie, a CSRF token bound to the session, and a login rate limit.
 *
 * Session token: `v1.<expiryMs>.<nonce>.<sig>` where sig = HMAC-SHA256 over
 * `v1.<expiryMs>.<nonce>`. The HMAC key is derived from SPINE_ADMIN_TOKEN and
 * the password's digest, so changing either signs everyone out. The nonce
 * must also have a live `staff_sessions` row: sign-out revokes it.
 */

import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { insertStaffSession, staffSessionLive } from '../../db/staff-ui-queries.js';

export const SESSION_COOKIE = 'staff_session';
export const FLASH_COOKIE = 'staff_flash';
export const FLASH_TTL_MS = 60 * 1000;
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const LOGIN_MAX_ATTEMPTS = 5;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;

export interface UiSecrets {
  password: string;
  /** SPINE_ADMIN_TOKEN. */
  hmacKey: string;
}

/** Both env vars set, else null (the UI answers 503). */
export function uiSecretsFromEnv(env: Record<string, string | undefined>): UiSecrets | null {
  const password = env.STAFF_UI_PASSWORD;
  const hmacKey = env.SPINE_ADMIN_TOKEN;
  if (!password || !hmacKey) return null;
  return { password, hmacKey };
}

function sha256(s: string): Buffer {
  return crypto.createHash('sha256').update(s, 'utf8').digest();
}

/** Constant-time password check over SHA-256 digests (equal length whatever the input). */
export function passwordMatches(input: string, expected: string): boolean {
  return safeEqual(input, expected);
}

function signingKey(s: UiSecrets): Buffer {
  return crypto.createHmac('sha256', s.hmacKey).update(`staff-ui:${sha256(s.password).toString('hex')}`).digest();
}

function mac(s: UiSecrets, data: string): string {
  return crypto.createHmac('sha256', signingKey(s)).update(data).digest('base64url');
}

/** Constant-time string equality: digests, so unequal lengths cost the same and never throw. */
function safeEqual(a: string, b: string): boolean {
  return crypto.timingSafeEqual(sha256(a), sha256(b));
}

/** Mint a session: a row in staff_sessions and the signed cookie value. */
export function issueSession(s: UiSecrets, db: Database.Database, nowMs: number): string {
  const nonce = crypto.randomBytes(16).toString('base64url');
  const expMs = nowMs + SESSION_TTL_MS;
  insertStaffSession(db, nonce, new Date(nowMs).toISOString(), new Date(expMs).toISOString());
  const body = `v1.${expMs}.${nonce}`;
  return `${body}.${mac(s, body)}`;
}

/** The session's nonce when the token is genuine, unexpired and its row is live (not signed out), else null. */
export function verifySession(s: UiSecrets, db: Database.Database, token: string | undefined, nowMs: number): string | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  const [v, exp, nonce, sig] = parts as [string, string, string, string];
  if (!safeEqual(sig, mac(s, `${v}.${exp}.${nonce}`))) return null;
  const expMs = Number(exp);
  if (!Number.isSafeInteger(expMs) || expMs <= nowMs || expMs > nowMs + SESSION_TTL_MS) return null;
  return staffSessionLive(db, nonce, new Date(nowMs).toISOString()) ? nonce : null;
}

export interface Notice { text: string; error?: boolean }

/**
 * A one-time notice carried across a POST → 303 → GET (e.g. a freshly minted
 * invite code): `<base64url json>.<expiryMs>.<sig>`, signed with the session
 * key and bound to the session nonce, valid 60 s, cleared when read.
 */
export function issueFlash(s: UiSecrets, sessionNonce: string, notice: Notice, nowMs: number): string {
  const payload = Buffer.from(JSON.stringify({ text: notice.text, error: notice.error === true }), 'utf8').toString('base64url');
  const exp = nowMs + FLASH_TTL_MS;
  return `${payload}.${exp}.${mac(s, `flash.${sessionNonce}.${payload}.${exp}`)}`;
}

export function readFlash(s: UiSecrets, sessionNonce: string, token: string | undefined, nowMs: number): Notice | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [payload, exp, sig] = parts as [string, string, string];
  if (!safeEqual(sig, mac(s, `flash.${sessionNonce}.${payload}.${exp}`))) return null;
  if (!(Number(exp) > nowMs)) return null;
  try {
    const v = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { text?: unknown; error?: unknown };
    return typeof v.text === 'string' ? { text: v.text, error: v.error === true } : null;
  } catch {
    return null;
  }
}

export function flashCookie(token: string): string {
  return `${FLASH_COOKIE}=${token}; Path=/staff; HttpOnly; Secure; SameSite=Lax; Max-Age=${FLASH_TTL_MS / 1000}`;
}

export function clearedFlashCookie(): string {
  return `${FLASH_COOKIE}=; Path=/staff; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/** The CSRF token for a session: derived from its nonce, so it is useless with any other session. */
export function csrfToken(s: UiSecrets, sessionNonce: string): string {
  return mac(s, `csrf.${sessionNonce}`);
}

export function csrfValid(s: UiSecrets, sessionNonce: string, token: unknown): boolean {
  return typeof token === 'string' && token.length > 0 && safeEqual(token, csrfToken(s, sessionNonce));
}

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/staff; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`;
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/staff; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/**
 * Login attempts per IP in a sliding window, in memory per process. `take`
 * counts the attempt before anything is awaited, so concurrent requests
 * cannot all slip past the check; false means refuse without looking at the
 * password. A successful login clears the IP's bucket.
 */
export function createLoginLimiter(max = LOGIN_MAX_ATTEMPTS, windowMs = LOGIN_WINDOW_MS) {
  const hits = new Map<string, number[]>();
  const recent = (ip: string, nowMs: number): number[] => {
    const r = (hits.get(ip) ?? []).filter((t) => nowMs - t < windowMs);
    if (r.length === 0) hits.delete(ip); else hits.set(ip, r);
    return r;
  };
  return {
    take(ip: string, nowMs: number): boolean {
      if (hits.size > 10_000) for (const k of [...hits.keys()]) recent(k, nowMs);
      const r = recent(ip, nowMs);
      if (r.length >= max) return false;
      hits.set(ip, [...r, nowMs]);
      return true;
    },
    succeed(ip: string): void {
      hits.delete(ip);
    },
  };
}
export type LoginLimiter = ReturnType<typeof createLoginLimiter>;
