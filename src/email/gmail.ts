import { google } from 'googleapis';
import { config } from '../config.js';
import type { RawEmail } from './types.js';

function getGmailClient() {
  const oauth2Client = new google.auth.OAuth2(
    config.gmail.clientId,
    config.gmail.clientSecret,
  );
  oauth2Client.setCredentials({
    refresh_token: config.gmail.refreshToken,
  });
  return google.gmail({ version: 'v1', auth: oauth2Client });
}

export async function fetchUnreadGmailEmails(
  since: string | null,
  maxResults: number = 50,
): Promise<RawEmail[]> {
  const gmail = getGmailClient();

  let query = 'is:unread';
  if (since) {
    const date = new Date(since);
    const afterDate = `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
    query += ` after:${afterDate}`;
  }

  const listResponse = await gmail.users.messages.list({
    userId: 'me',
    q: query,
    maxResults,
  });

  const messageIds = listResponse.data.messages ?? [];
  const emails: RawEmail[] = [];

  for (const { id } of messageIds) {
    if (!id) continue;

    const msg = await gmail.users.messages.get({
      userId: 'me',
      id,
      format: 'full',
    });

    const headers = msg.data.payload?.headers ?? [];
    const getHeader = (name: string): string =>
      headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';

    const from = getHeader('From');
    const senderMatch = from.match(/^(?:"?(.+?)"?\s)?<?([^\s>]+)>?$/);
    const senderName = senderMatch?.[1] ?? '';
    const senderEmail = senderMatch?.[2] ?? from;

    const body = extractBody(msg.data.payload);

    emails.push({
      id: msg.data.id ?? id,
      account: config.gmail.userEmail,
      sender: senderEmail,
      senderName,
      subject: getHeader('Subject'),
      bodyPreview: msg.data.snippet ?? '',
      body: body.slice(0, 3000),
      receivedAt: new Date(Number(msg.data.internalDate ?? 0)).toISOString(),
      threadId: msg.data.threadId ?? '',
      isRead: false,
    });
  }

  return emails;
}

function extractBody(payload: any): string {
  if (!payload) return '';

  if (payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf-8');
  }

  if (payload.parts) {
    const textPart = payload.parts.find((p: any) => p.mimeType === 'text/plain');
    if (textPart?.body?.data) {
      return Buffer.from(textPart.body.data, 'base64url').toString('utf-8');
    }

    const htmlPart = payload.parts.find((p: any) => p.mimeType === 'text/html');
    if (htmlPart?.body?.data) {
      const html = Buffer.from(htmlPart.body.data, 'base64url').toString('utf-8');
      return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }

    for (const part of payload.parts) {
      const result = extractBody(part);
      if (result) return result;
    }
  }

  return '';
}
