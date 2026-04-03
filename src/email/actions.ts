import type { ClassifiedEmail } from './types.js';

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

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

async function getToken(): Promise<string> {
  const { getGraphToken } = await import('../auth/graph.js');
  return getGraphToken();
}

export async function archiveOutlookEmail(userEmail: string, messageId: string): Promise<void> {
  const token = await getToken();

  const response = await fetch(`${GRAPH_BASE}/users/${userEmail}/messages/${messageId}/move`, {
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
  const token = await getToken();

  const response = await fetch(`${GRAPH_BASE}/users/${userEmail}/messages/${messageId}`, {
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
  const token = await getToken();

  const response = await fetch(`${GRAPH_BASE}/users/${userEmail}/messages/${messageId}`, {
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
