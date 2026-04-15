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
  anthropic: {
    apiKey: required('ANTHROPIC_API_KEY'),
  },
  telegram: {
    botToken: required('TELEGRAM_BOT_TOKEN'),
    chatId: required('TELEGRAM_CHAT_ID'),
  },
  api: {
    secret: optional('API_SECRET', ''),
    port: parseInt(optional('PORT', '3000')),
  },
  db: {
    path: optional('DB_PATH', path.join(process.cwd(), 'data', 'secretary.db')),
  },
  github: {
    token: optional('GITHUB_TOKEN', ''),
    org: optional('GITHUB_ORG', 'dearborndenim'),
  },
  pieceWorkScanner: {
    url: optional('PIECE_WORK_SCANNER_URL', ''),
    apiKey: optional('PIECE_WORK_SCANNER_API_KEY', ''),
  },
} as const;

if (!config.api.secret) {
  console.warn('WARNING: API_SECRET is not set — all API requests will be rejected until configured');
}
