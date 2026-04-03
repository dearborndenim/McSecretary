import { getGraphToken } from '../auth/graph.js';
import type { RawEmail } from './types.js';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

interface GraphMessage {
  id: string;
  from: { emailAddress: { address: string; name: string } };
  subject: string;
  bodyPreview: string;
  body: { content: string; contentType: string };
  receivedDateTime: string;
  conversationId: string;
  isRead: boolean;
}

interface GraphResponse {
  value: GraphMessage[];
  '@odata.nextLink'?: string;
}

export async function fetchUnreadOutlookEmails(
  userEmail: string,
  since: string | null,
  maxResults: number = 50,
): Promise<RawEmail[]> {
  const token = await getGraphToken();

  let filter = 'isRead eq false';
  if (since) {
    filter += ` and receivedDateTime ge ${since}`;
  }

  const url = `${GRAPH_BASE}/users/${userEmail}/messages?$filter=${encodeURIComponent(filter)}&$top=${maxResults}&$orderby=receivedDateTime desc&$select=id,from,subject,bodyPreview,body,receivedDateTime,conversationId,isRead`;

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Graph API error (${response.status}): ${text}`);
  }

  const data = (await response.json()) as GraphResponse;

  return data.value.map((msg): RawEmail => ({
    id: msg.id,
    account: userEmail,
    sender: msg.from.emailAddress.address,
    senderName: msg.from.emailAddress.name,
    subject: msg.subject,
    bodyPreview: msg.bodyPreview,
    body: stripHtml(msg.body.content),
    receivedAt: msg.receivedDateTime,
    threadId: msg.conversationId,
    isRead: msg.isRead,
  }));
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
