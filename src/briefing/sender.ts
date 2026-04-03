const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const BRIEFING_RECIPIENT = 'robert@mcmillan-manufacturing.com';

export async function sendBriefingEmail(briefingMarkdown: string): Promise<void> {
  const { getGraphToken } = await import('../auth/graph.js');
  const { config } = await import('../config.js');
  const token = await getGraphToken();

  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'America/Chicago',
  });

  const subject = `Morning Briefing — ${today}`;

  const response = await fetch(`${GRAPH_BASE}/users/${config.outlook.email2}/sendMail`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: {
        subject,
        body: {
          contentType: 'text',
          content: briefingMarkdown,
        },
        toRecipients: [
          { emailAddress: { address: BRIEFING_RECIPIENT } },
        ],
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to send briefing email: ${response.status} ${text}`);
  }

  console.log(`Briefing email sent via Outlook: "${subject}"`);
}
