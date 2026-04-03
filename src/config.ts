import path from 'node:path';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export const config = {
  azure: {
    tenantId: required('AZURE_TENANT_ID'),
    clientId: required('AZURE_CLIENT_ID'),
    clientSecret: required('AZURE_CLIENT_SECRET'),
  },
  outlook: {
    email1: required('OUTLOOK_USER_EMAIL_1'),
    email2: required('OUTLOOK_USER_EMAIL_2'),
  },
  gmail: {
    clientId: required('GMAIL_CLIENT_ID'),
    clientSecret: required('GMAIL_CLIENT_SECRET'),
    refreshToken: required('GMAIL_REFRESH_TOKEN'),
    userEmail: required('GMAIL_USER_EMAIL'),
  },
  anthropic: {
    apiKey: required('ANTHROPIC_API_KEY'),
  },
  db: {
    path: optional('DB_PATH', path.join(process.cwd(), 'data', 'secretary.db')),
  },
} as const;
