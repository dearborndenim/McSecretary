/**
 * Staff admin UI auth (staff admin UI spec §2): one admin password, a signed
 * session cookie, a CSRF token bound to the session, and a login rate limit.
 *
 * Session token: `v1.<expiryMs>.<nonce>.<sig>` where sig = HMAC-SHA256 over
 * `v1.<expiryMs>.<nonce>`. The HMAC key is derived from SPINE_ADMIN_TOKEN and
 * the password's digest, so changing either signs everyone out.
 */

import crypto from 'node:crypto';

export const SESSION_COOKIE = 'staff_session';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const LOGIN_MAX_FAILURES = 5;
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

export function issueSession(s: UiSecrets, nowMs: number): string {
  const nonce = crypto.randomBytes(16).toString('base64url');
  const body = `v1.${nowMs + SESSION_TTL_MS}.${nonce}`;
  return `${body}.${mac(s, body)}`;
}

/** The session's nonce when the token is genuine and unexpired, else null. */
export function verifySession(s: UiSecrets, token: string | undefined, nowMs: number): string | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  const [v, exp, nonce, sig] = parts as [string, string, string, string];
  if (!safeEqual(sig, mac(s, `${v}.${exp}.${nonce}`))) return null;
  const expMs = Number(exp);
  if (!Number.isSafeInteger(expMs) || expMs <= nowMs || expMs > nowMs + SESSION_TTL_MS) return null;
  return nonce;
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
 * Failed logins per IP in a sliding window, in memory per process. Blocked
 * means the next attempt is refused before the password is looked at.
 */
export function createLoginLimiter(max = LOGIN_MAX_FAILURES, windowMs = LOGIN_WINDOW_MS) {
  const fails = new Map<string, number[]>();
  const recent = (ip: string, nowMs: number): number[] => {
    const r = (fails.get(ip) ?? []).filter((t) => nowMs - t < windowMs);
    if (r.length === 0) fails.delete(ip); else fails.set(ip, r);
    return r;
  };
  return {
    blocked(ip: string, nowMs: number): boolean {
      return recent(ip, nowMs).length >= max;
    },
    fail(ip: string, nowMs: number): void {
      if (fails.size > 10_000) for (const k of [...fails.keys()]) recent(k, nowMs);
      fails.set(ip, [...recent(ip, nowMs), nowMs]);
    },
    succeed(ip: string): void {
      fails.delete(ip);
    },
  };
}
export type LoginLimiter = ReturnType<typeof createLoginLimiter>;
