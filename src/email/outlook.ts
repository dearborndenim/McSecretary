import { getGraphToken } from '../auth/graph.js';
import type { RawEmail } from './types.js';
import { GRAPH_BASE, graphSegment } from '../auth/graph-base.js';
import { SWEEP_MANAGED_FOLDER_NAMES } from './inbox-sweep-rules.js';

interface GraphMessage {
  id: string;
  from: { emailAddress: { address: string; name: string } };
  subject: string;
  bodyPreview: string;
  body: { content: string; contentType: string };
  receivedDateTime: string;
  conversationId: string;
  isRead: boolean;
  parentFolderId?: string;
}

interface GraphResponse {
  value: GraphMessage[];
  '@odata.nextLink'?: string;
}

/**
 * Normalise a `since` timestamp into an ISO 8601 UTC literal Graph's OData
 * `$filter` will accept. SQLite's `datetime('now')` produces
 * `YYYY-MM-DD HH:MM:SS` (UTC, space-separated, no timezone designator), which
 * Graph rejects outright. An already-ISO input (with `Z` or a `±HH:MM`
 * offset) passes through with the same instant, just reformatted by
 * `Date#toISOString`.
 */
export function toGraphDateTime(since: string): string {
  let normalised = since.replace(' ', 'T');
  if (!/Z$|[+-]\d{2}:\d{2}$/.test(normalised)) {
    normalised += 'Z';
  }

  const date = new Date(normalised);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`toGraphDateTime: could not parse "${since}" as a date`);
  }

  return date.toISOString();
}

export async function fetchUnreadOutlookEmails(
  userEmail: string,
  since: string | null,
  maxResults: number = 50,
): Promise<RawEmail[]> {
  const token = await getGraphToken();

  let filter = 'isRead eq false';
  if (since) {
    filter += ` and receivedDateTime ge ${toGraphDateTime(since)}`;
  }

  const url = `${GRAPH_BASE}/users/${userEmail}/messages?$filter=${encodeURIComponent(filter)}&$top=${maxResults}&$orderby=receivedDateTime desc&$select=id,from,subject,bodyPreview,body,receivedDateTime,conversationId,isRead,parentFolderId`;

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Graph API error (${response.status}): ${text}`);
  }

  const data = (await response.json()) as GraphResponse;
  const skip = data.value.length > 0 ? await sweepManagedFolderIds(userEmail, token) : new Set<string>();

  return data.value.filter((msg) => !msg.parentFolderId || !skip.has(msg.parentFolderId)).map((msg): RawEmail => ({
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

export function stripHtml(html: string): string {
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

/**
 * Ids of the top-level folders the Inbox Sweep files into (by display name),
 * from a Graph `mailFolders` list. Triage leaves unread mail in these alone so
 * it neither re-classifies nor archives what the sweep already filed.
 */
export function sweepManagedIdsFrom(json: unknown): Set<string> {
  const rows = (json as { value?: unknown })?.value;
  if (!Array.isArray(rows)) throw new Error('mailFolders response has no value array');
  const names = new Set(SWEEP_MANAGED_FOLDER_NAMES.map((n) => n.toLowerCase()));
  const ids = new Set<string>();
  for (const row of rows) {
    const r = row as { id?: unknown; displayName?: unknown };
    if (typeof r.id === 'string' && typeof r.displayName === 'string' && names.has(r.displayName.trim().toLowerCase())) {
      ids.add(r.id);
    }
  }
  return ids;
}

/** A failed lookup excludes nothing (triage behaves as before) and is logged. */
async function sweepManagedFolderIds(userEmail: string, token: string): Promise<Set<string>> {
  try {
    const res = await fetch(`${GRAPH_BASE}/users/${graphSegment(userEmail)}/mailFolders?$top=100&$select=id,displayName`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Graph ${res.status}`);
    return sweepManagedIdsFrom(await res.json());
  } catch (err) {
    console.error(`Triage: sweep folder lookup failed for ${userEmail}: ${err instanceof Error ? err.message : String(err)}`);
    return new Set();
  }
}
