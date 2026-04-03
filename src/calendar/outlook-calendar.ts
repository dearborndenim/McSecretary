import type { UnifiedEvent } from './types.js';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

interface GraphCalendarEvent {
  id: string;
  subject: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  location: { displayName: string };
  isAllDay: boolean;
  showAs: string;
  isCancelled: boolean;
  responseStatus: { response: string };
  attendees: { emailAddress: { address: string } }[];
}

interface GraphCalendarResponse {
  value: GraphCalendarEvent[];
}

export async function fetchOutlookCalendarEvents(
  userEmail: string,
  startDate: string,
  endDate: string,
): Promise<UnifiedEvent[]> {
  const { getGraphToken } = await import('../auth/graph.js');
  const token = await getGraphToken();

  const url = `${GRAPH_BASE}/users/${userEmail}/calendarview?startDateTime=${startDate}&endDateTime=${endDate}&$top=100&$select=id,subject,start,end,location,isAllDay,showAs,isCancelled,responseStatus,attendees`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Prefer: 'outlook.timezone="UTC"',
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Graph Calendar API error (${response.status}): ${text}`);
  }

  const data = (await response.json()) as GraphCalendarResponse;

  return data.value
    .filter((evt) => !evt.isCancelled && evt.responseStatus.response !== 'declined')
    .map((evt): UnifiedEvent => ({
      id: evt.id,
      source: 'outlook',
      calendarEmail: userEmail,
      title: evt.subject,
      startTime: evt.start.dateTime.endsWith('Z') ? evt.start.dateTime : evt.start.dateTime + 'Z',
      endTime: evt.end.dateTime.endsWith('Z') ? evt.end.dateTime : evt.end.dateTime + 'Z',
      location: evt.location?.displayName ?? '',
      isAllDay: evt.isAllDay,
      status: evt.showAs === 'tentative' ? 'tentative' : 'confirmed',
      attendees: evt.attendees?.map((a) => a.emailAddress.address) ?? [],
    }));
}
