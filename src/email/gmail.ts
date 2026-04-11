/**
 * Gmail email fetcher — parallel to outlook.ts.
 * Fetches recent emails from Gmail API and returns RawEmail[].
 * Uses native fetch with Google OAuth2 tokens.
 */

import { getGmailToken } from '../auth/google.js';
import type { RawEmail } from './types.js';
import type { EmailSummary } from './reader.js';

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1';
const GMAIL_USER = 'me'; // authenticated user

interface GmailMessageRef {
  id: string;
  threadId: string;
}

interface GmailListResponse {
  messages?: GmailMessageRef[];
  nextPageToken?: string;
  resultSizeEstimate: number;
}

interface GmailHeader {
  name: string;
  value: string;
}

interface GmailMessagePart {
  mimeType: string;
  headers?: GmailHeader[];
  body: { data?: string; size: number };
  parts?: GmailMessagePart[];
}

interface GmailMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  snippet: string;
  payload: GmailMessagePart;
  internalDate: string;
}

/**
 * Fetch unread Gmail emails (for triage pipeline).
 * Mirrors fetchUnreadOutlookEmails signature.
 */
export async function fetchUnreadGmailEmails(
  userEmail: string,
  since: string | null,
  maxResults: number = 50,
): Promise<RawEmail[]> {
  const token = await getGmailToken();

  let query = 'is:unread';
  if (since) {
    // Gmail search uses after:YYYY/MM/DD format
    const sinceDate = new Date(since);
    const dateStr = `${sinceDate.getFullYear()}/${String(sinceDate.getMonth() + 1).padStart(2, '0')}/${String(sinceDate.getDate()).padStart(2, '0')}`;
    query += ` after:${dateStr}`;
  }

  return fetchGmailMessages(token, userEmail, query, maxResults);
}

/**
 * Fetch recent Gmail emails (for read-only context, like reader.ts).
 * Returns emails from the last N hours.
 */
export async function fetchRecentGmailEmails(
  userEmail: string,
  hours: number = 48,
  maxResults: number = 30,
): Promise<RawEmail[]> {
  const token = await getGmailToken();

  const since = new Date(Date.now() - hours * 60 * 60 * 1000);
  const dateStr = `${since.getFullYear()}/${String(since.getMonth() + 1).padStart(2, '0')}/${String(since.getDate()).padStart(2, '0')}`;
  const query = `after:${dateStr}`;

  return fetchGmailMessages(token, userEmail, query, maxResults);
}

/**
 * Fetch recent Gmail emails as EmailSummary[] (for interactive context).
 * Matches the signature of fetchRecentEmails in reader.ts.
 */
export async function fetchRecentGmailEmailSummaries(
  userEmail: string,
  hours: number = 48,
  maxResults: number = 30,
): Promise<EmailSummary[]> {
  const raw = await fetchRecentGmailEmails(userEmail, hours, maxResults);
  return raw.map((e): EmailSummary => ({
    id: e.id,
    account: e.account,
    from: e.sender,
    fromName: e.senderName,
    subject: e.subject,
    bodyPreview: e.bodyPreview,
    receivedAt: e.receivedAt,
    isRead: e.isRead,
    categories: [],
  }));
}

async function fetchGmailMessages(
  token: string,
  userEmail: string,
  query: string,
  maxResults: number,
): Promise<RawEmail[]> {
  // Step 1: List message IDs matching query
  const listUrl = `${GMAIL_BASE}/users/${GMAIL_USER}/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`;

  const listResponse = await fetch(listUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!listResponse.ok) {
    const text = await listResponse.text();
    throw new Error(`Gmail API list error (${listResponse.status}): ${text}`);
  }

  const listData = (await listResponse.json()) as GmailListResponse;

  if (!listData.messages || listData.messages.length === 0) {
    return [];
  }

  // Step 2: Fetch full message details in parallel (batch of up to maxResults)
  const messagePromises = listData.messages.map((ref) =>
    fetchGmailMessage(token, ref.id),
  );
  const messages = await Promise.all(messagePromises);

  // Step 3: Convert to RawEmail format
  return messages
    .filter((msg): msg is GmailMessage => msg !== null)
    .map((msg): RawEmail => {
      const headers = msg.payload.headers ?? [];
      const from = getHeader(headers, 'From') ?? 'unknown';
      const subject = getHeader(headers, 'Subject') ?? '(no subject)';
      const { name: senderName, email: senderEmail } = parseFromHeader(from);

      const body = extractBody(msg.payload);
      const isRead = !msg.labelIds.includes('UNREAD');

      return {
        id: msg.id,
        account: userEmail,
        sender: senderEmail,
        senderName,
        subject,
        bodyPreview: msg.snippet,
        body: body.slice(0, 3000),
        receivedAt: new Date(parseInt(msg.internalDate)).toISOString(),
        threadId: msg.threadId,
        isRead,
      };
    });
}

async function fetchGmailMessage(token: string, messageId: string): Promise<GmailMessage | null> {
  const url = `${GMAIL_BASE}/users/${GMAIL_USER}/messages/${messageId}?format=full`;

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    console.warn(`Gmail API get message ${messageId} failed (${response.status})`);
    return null;
  }

  return (await response.json()) as GmailMessage;
}

function getHeader(headers: GmailHeader[], name: string): string | undefined {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
}

function parseFromHeader(from: string): { name: string; email: string } {
  // "Rob McMillan <rob@example.com>" or just "rob@example.com"
  const match = from.match(/^"?([^"<]*)"?\s*<?([^>]+@[^>]+)>?$/);
  if (match && match[1] !== undefined && match[2] !== undefined) {
    return { name: match[1].trim(), email: match[2].trim() };
  }
  return { name: from, email: from };
}

function extractBody(part: GmailMessagePart): string {
  // Prefer text/plain, fall back to text/html (stripped)
  if (part.mimeType === 'text/plain' && part.body.data) {
    return decodeBase64Url(part.body.data);
  }

  if (part.parts) {
    // Look for text/plain first
    for (const sub of part.parts) {
      if (sub.mimeType === 'text/plain' && sub.body.data) {
        return decodeBase64Url(sub.body.data);
      }
    }
    // Fall back to text/html
    for (const sub of part.parts) {
      if (sub.mimeType === 'text/html' && sub.body.data) {
        return stripHtml(decodeBase64Url(sub.body.data));
      }
    }
    // Recurse into nested multipart
    for (const sub of part.parts) {
      const result = extractBody(sub);
      if (result) return result;
    }
  }

  if (part.mimeType === 'text/html' && part.body.data) {
    return stripHtml(decodeBase64Url(part.body.data));
  }

  return '';
}

function decodeBase64Url(data: string): string {
  // Gmail API returns base64url-encoded data
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(base64, 'base64').toString('utf-8');
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 3000);
}
