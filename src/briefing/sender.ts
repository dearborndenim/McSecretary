import { google } from 'googleapis';

export async function sendBriefingEmail(briefingMarkdown: string): Promise<void> {
  const { config } = await import('../config.js');

  const oauth2Client = new google.auth.OAuth2(
    config.gmail.clientId,
    config.gmail.clientSecret,
  );
  oauth2Client.setCredentials({
    refresh_token: config.gmail.refreshToken,
  });
  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'America/Chicago',
  });

  const subject = `Morning Briefing — ${today}`;

  const messageParts = [
    `To: ${config.gmail.userEmail}`,
    `From: ${config.gmail.userEmail}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    briefingMarkdown,
  ];

  const rawMessage = messageParts.join('\n');
  const encodedMessage = Buffer.from(rawMessage).toString('base64url');

  await gmail.users.messages.send({
    userId: 'me',
    requestBody: {
      raw: encodedMessage,
    },
  });

  console.log(`Briefing email sent: "${subject}"`);
}
