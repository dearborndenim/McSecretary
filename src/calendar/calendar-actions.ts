/**
 * Calendar write actions via Graph API.
 * Create, modify, and delete Outlook calendar events.
 */

import { GRAPH_BASE, lazyGraphToken, defaultOutlookMailbox, graphSegment } from '../auth/graph-base.js';

export async function createCalendarEvent(
  userEmail: string | undefined,
  subject: string,
  startDateTime: string,
  endDateTime: string,
  options?: {
    location?: string;
    body?: string;
    attendees?: string[];
    isOnline?: boolean;
  },
): Promise<{ id: string; subject: string; webLink: string }> {
  const token = await lazyGraphToken();
  const email = userEmail ?? await defaultOutlookMailbox();

  const eventBody: any = {
    subject,
    start: { dateTime: startDateTime, timeZone: 'America/Chicago' },
    end: { dateTime: endDateTime, timeZone: 'America/Chicago' },
  };

  if (options?.location) {
    eventBody.location = { displayName: options.location };
  }

  if (options?.body) {
    eventBody.body = { contentType: 'text', content: options.body };
  }

  if (options?.attendees) {
    eventBody.attendees = options.attendees.map((email) => ({
      emailAddress: { address: email },
      type: 'required',
    }));
  }

  if (options?.isOnline) {
    eventBody.isOnlineMeeting = true;
    eventBody.onlineMeetingProvider = 'teamsForBusiness';
  }

  const response = await fetch(`${GRAPH_BASE}/users/${graphSegment(email)}/events`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(eventBody),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to create event: ${response.status} ${text}`);
  }

  const data = await response.json();
  return { id: data.id, subject: data.subject, webLink: data.webLink ?? '' };
}

export async function updateCalendarEvent(
  userEmail: string | undefined,
  eventId: string,
  updates: {
    subject?: string;
    startDateTime?: string;
    endDateTime?: string;
    location?: string;
    body?: string;
  },
): Promise<void> {
  const token = await lazyGraphToken();
  const email = userEmail ?? await defaultOutlookMailbox();

  const updateBody: any = {};

  if (updates.subject) updateBody.subject = updates.subject;
  if (updates.startDateTime) updateBody.start = { dateTime: updates.startDateTime, timeZone: 'America/Chicago' };
  if (updates.endDateTime) updateBody.end = { dateTime: updates.endDateTime, timeZone: 'America/Chicago' };
  if (updates.location) updateBody.location = { displayName: updates.location };
  if (updates.body) updateBody.body = { contentType: 'text', content: updates.body };

  const response = await fetch(`${GRAPH_BASE}/users/${graphSegment(email)}/events/${graphSegment(eventId)}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(updateBody),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to update event: ${response.status} ${text}`);
  }
}

export async function deleteCalendarEvent(
  userEmail: string | undefined,
  eventId: string,
): Promise<void> {
  const token = await lazyGraphToken();
  const email = userEmail ?? await defaultOutlookMailbox();

  const response = await fetch(`${GRAPH_BASE}/users/${graphSegment(email)}/events/${graphSegment(eventId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to delete event: ${response.status} ${text}`);
  }
}
