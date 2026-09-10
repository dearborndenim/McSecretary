/**
 * Read-only email fetcher for interactive queries.
 * Unlike outlook.ts (used by triage), this NEVER marks emails as read,
 * archives, or modifies anything. It just reads.
 */

import { stripHtml } from './outlook.js';
import type { RawEmail } from './types.js';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

export interface EmailSummary {
  id: string;
  account: string;
  from: string;
  fromName: string;
  subject: string;
  bodyPreview: string;
  receivedAt: string;
  isRead: boolean;
  categories: string[];
  /** Only present when `fetchRecentEmails` was called with `includeBody: true`. */
  body?: string;
  /** Only present when `fetchRecentEmails` was called with `includeBody: true`. */
  threadId?: string;
}

export async function fetchRecentEmails(
  userEmail: string,
  hours: number = 48,
  maxResults: number = 30,
  includeBody: boolean = false,
): Promise<EmailSummary[]> {
  const { getGraphToken } = await import('../auth/graph.js');
  const token = await getGraphToken();

  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const fields = includeBody
    ? 'id,from,subject,bodyPreview,body,receivedDateTime,isRead,categories,conversationId'
    : 'id,from,subject,bodyPreview,receivedDateTime,isRead,categories';
  const url = `${GRAPH_BASE}/users/${userEmail}/messages?$filter=receivedDateTime ge ${since}&$top=${maxResults}&$orderby=receivedDateTime desc&$select=${fields}`;

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Graph API error (${response.status}): ${text}`);
  }

  const data = (await response.json()) as { value: any[] };

  return data.value.map((msg: any): EmailSummary => ({
    id: msg.id,
    account: userEmail,
    from: msg.from?.emailAddress?.address ?? 'unknown',
    fromName: msg.from?.emailAddress?.name ?? '',
    subject: msg.subject ?? '(no subject)',
    bodyPreview: msg.bodyPreview ?? '',
    receivedAt: msg.receivedDateTime,
    isRead: msg.isRead,
    categories: msg.categories ?? [],
    ...(includeBody ? { body: stripHtml(msg.body?.content ?? ''), threadId: msg.conversationId ?? '' } : {}),
  }));
}

/**
 * Adapt an `EmailSummary` fetched with `includeBody: true` into the `RawEmail`
 * shape the RFQ intake (`matchRfqReply` / `processRfqReply`) expects. Used by
 * the 30-minute Email Scan job and the "scan rfq" command — both fetch with
 * `fetchRecentEmails(..., true)` first.
 */
export function toRawEmail(e: EmailSummary): RawEmail {
  return {
    id: e.id,
    account: e.account,
    sender: e.from,
    senderName: e.fromName,
    subject: e.subject,
    bodyPreview: e.bodyPreview,
    body: e.body ?? e.bodyPreview,
    receivedAt: e.receivedAt,
    threadId: e.threadId ?? '',
    isRead: e.isRead,
  };
}

export function formatEmailsForContext(emails: EmailSummary[]): string {
  if (emails.length === 0) return 'No emails found in this timeframe.';

  return emails.map((e, i) =>
    `${i + 1}. ID: ${e.id}\n   Account: ${e.account}\n   From: ${e.fromName} <${e.from}>\n   Subject: ${e.subject}\n   Preview: ${e.bodyPreview.slice(0, 150)}\n   Received: ${e.receivedAt}\n   Read: ${e.isRead ? 'yes' : 'NO — UNREAD'}\n   Categories: ${e.categories.length > 0 ? e.categories.join(', ') : '(none)'}`
  ).join('\n\n');
}
