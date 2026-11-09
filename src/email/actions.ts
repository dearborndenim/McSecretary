import type { ClassifiedEmail } from './types.js';
import { GRAPH_BASE, lazyGraphToken, graphSegment } from '../auth/graph-base.js';

export interface EmailAction {
  type: 'archive' | 'mark_read' | 'flag_for_review' | 'no_action';
  reason: string;
}

const AUTO_ARCHIVE_CATEGORIES = new Set(['junk', 'newsletter', 'promotional']);
const HIGH_CONFIDENCE_THRESHOLD = 0.9;

export function determineAction(email: ClassifiedEmail): EmailAction {
  if (AUTO_ARCHIVE_CATEGORIES.has(email.category)) {
    if (email.confidence >= HIGH_CONFIDENCE_THRESHOLD || email.actionNeeded === 'archive') {
      return { type: 'archive', reason: `Auto-archive ${email.category} (confidence: ${email.confidence})` };
    }
    return { type: 'flag_for_review', reason: `Low confidence ${email.category} — needs manual review` };
  }

  if (email.category === 'transactional' && email.actionNeeded === 'fyi_only') {
    return { type: 'mark_read', reason: 'Transactional FYI — marked as read' };
  }

  if (email.actionNeeded === 'reply_required' || email.urgency === 'critical' || email.urgency === 'high') {
    return { type: 'flag_for_review', reason: `${email.category} — needs attention (${email.urgency})` };
  }

  return { type: 'flag_for_review', reason: `${email.category} — included in briefing` };
}

export async function archiveOutlookEmail(userEmail: string, messageId: string): Promise<void> {
  const token = await lazyGraphToken();

  const response = await fetch(`${GRAPH_BASE}/users/${graphSegment(userEmail)}/messages/${graphSegment(messageId)}/move`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ destinationId: 'archive' }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to archive Outlook message ${messageId}: ${response.status} ${text}`);
  }
}

export async function markOutlookAsRead(userEmail: string, messageId: string): Promise<void> {
  const token = await lazyGraphToken();

  const response = await fetch(`${GRAPH_BASE}/users/${graphSegment(userEmail)}/messages/${graphSegment(messageId)}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ isRead: true }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to mark Outlook message ${messageId} as read: ${response.status} ${text}`);
  }
}

export async function categorizeOutlookEmail(
  userEmail: string,
  messageId: string,
  category: string,
): Promise<void> {
  const token = await lazyGraphToken();

  const response = await fetch(`${GRAPH_BASE}/users/${graphSegment(userEmail)}/messages/${graphSegment(messageId)}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ categories: [category] }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to categorize Outlook message ${messageId}: ${response.status} ${text}`);
  }
}

// ---------------------------------------------------------------------------
// Inbox Sweep moves (plan 2026-11-06-inbox-sweep.md Task 4). Moves only: this
// module has no delete call, and the sweep never sends, replies or forwards.
// ---------------------------------------------------------------------------

/** Graph well-known folder names the sweep moves into without a lookup. */
export const WELL_KNOWN_SWEEP_FOLDERS = ['archive', 'junkemail'] as const;

export interface GraphDeps {
  fetch?: typeof fetch;
  token?: () => Promise<string>;
}

/** The id of the top-level folder named `displayName` in a Graph `mailFolders` list, case-insensitive; null when absent. */
export function folderIdFromList(json: unknown, displayName: string): string | null {
  const rows = (json as { value?: unknown })?.value;
  if (!Array.isArray(rows)) throw new Error('mailFolders response has no value array');
  const want = displayName.trim().toLowerCase();
  for (const row of rows) {
    const r = row as { id?: unknown; displayName?: unknown };
    if (typeof r.id === 'string' && typeof r.displayName === 'string' && r.displayName.trim().toLowerCase() === want) {
      return r.id;
    }
  }
  return null;
}

async function graphJson(deps: GraphDeps, method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
  const doFetch = deps.fetch ?? fetch;
  const token = await (deps.token ?? lazyGraphToken)();
  const res = await doFetch(`${GRAPH_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Graph ${method} ${path.split('?')[0]} failed: ${res.status} ${text.slice(0, 300)}`);
  }
  return res.json();
}

/**
 * The id of the mailbox's top-level folder `displayName`, creating it when
 * missing. A well-known name (`archive`, `junkemail`) is returned as-is: Graph
 * accepts it as a `destinationId`.
 */
export async function ensureFolder(mailbox: string, displayName: string, deps: GraphDeps = {}): Promise<string> {
  if ((WELL_KNOWN_SWEEP_FOLDERS as readonly string[]).includes(displayName)) return displayName;
  const base = `/users/${graphSegment(mailbox)}/mailFolders`;
  // $top=100: the default page is 10, and both mailboxes have more top-level folders than that.
  const list = await graphJson(deps, 'GET', `${base}?$top=100&$select=id,displayName`);
  const found = folderIdFromList(list, displayName);
  if (found) return found;
  const created = (await graphJson(deps, 'POST', base, { displayName })) as { id?: unknown };
  if (typeof created.id !== 'string') throw new Error(`Creating folder "${displayName}" returned no id`);
  return created.id;
}

/** Move one message to a folder id or well-known name. Returns the moved message's new id (Graph re-ids a moved message). */
export async function moveToFolder(
  mailbox: string,
  messageId: string,
  destinationId: string,
  deps: GraphDeps = {},
): Promise<string | null> {
  const moved = (await graphJson(
    deps,
    'POST',
    `/users/${graphSegment(mailbox)}/messages/${graphSegment(messageId)}/move`,
    { destinationId },
  )) as { id?: unknown };
  return typeof moved.id === 'string' ? moved.id : null;
}
