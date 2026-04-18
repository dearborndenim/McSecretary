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
  // Legacy single-user config — used for seed only, not for runtime email fetching
  outlook: {
    email1: optional('OUTLOOK_USER_EMAIL_1', ''),
    email2: optional('OUTLOOK_USER_EMAIL_2', ''),
  },
  anthropic: {
    apiKey: required('ANTHROPIC_API_KEY'),
  },
  telegram: {
    botToken: required('TELEGRAM_BOT_TOKEN'),
    // Legacy single-user chat ID — used for Robert's seed only
    chatId: optional('TELEGRAM_CHAT_ID', ''),
  },
  api: {
    secret: optional('API_SECRET', ''),
    port: parseInt(optional('PORT', '3000')),
  },
  db: {
    path: optional('DB_PATH', '/data/secretary.db'),
  },
  github: {
    token: optional('GITHUB_TOKEN', ''),
    org: optional('GITHUB_ORG', 'dearborndenim'),
  },
  pieceWorkScanner: {
    url: optional('PIECE_WORK_SCANNER_URL', ''),
    apiKey: optional('PIECE_WORK_SCANNER_API_KEY', ''),
  },
  poReceiver: {
    url: optional('PO_RECEIVER_URL', ''),
    apiKey: optional('PO_RECEIVER_API_KEY', ''),
  },
} as const;

if (!config.api.secret) {
  console.warn('WARNING: API_SECRET is not set — all API requests will be rejected until configured');
}
