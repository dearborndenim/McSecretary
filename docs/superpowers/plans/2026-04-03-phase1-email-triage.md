# Phase 1: Email Triage Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the overnight email triage pipeline that fetches unread emails from 2 Outlook accounts + Gmail, classifies them with Claude Haiku, applies labels, builds a sender reputation database, generates a morning briefing with Claude Sonnet, and emails it to Rob's Gmail.

**Architecture:** A TypeScript Node.js service designed to run as a Railway cron job. It connects directly to Microsoft Graph API (for Outlook) and Gmail API (for personal email), uses the Anthropic SDK for LLM classification and briefing generation, and persists all data to a local SQLite database. The service runs once (process emails → generate briefing → exit), triggered by Railway's cron scheduler.

**Tech Stack:** TypeScript (strict), Node.js LTS, `@anthropic-ai/sdk`, `@azure/msal-node`, `googleapis`, `better-sqlite3`, `tsx`

**Reference docs:** `Projects/Claude Cowork Setup/secretary-vision.md`, `claude-secretary-architecture.md`, `claude-secretary-v2-expanded.md`, `mcsecretary-tech-stack.md`

---

## File Structure

```
mcsecretary/
├── src/
│   ├── index.ts              # Entry point — orchestrates the full triage run
│   ├── config.ts             # Environment variable loading + validation
│   ├── db/
│   │   ├── schema.ts         # SQLite schema init (CREATE TABLE statements)
│   │   └── queries.ts        # Typed query helpers (insert email, get sender, etc.)
│   ├── auth/
│   │   └── graph.ts          # MSAL client-credentials token acquisition
│   ├── email/
│   │   ├── outlook.ts        # Fetch unread emails from Outlook via Graph API
│   │   ├── gmail.ts          # Fetch unread emails from Gmail API
│   │   ├── classifier.ts     # LLM classification with Claude Haiku
│   │   └── actions.ts        # Apply labels, archive, move (Graph + Gmail)
│   ├── briefing/
│   │   └── generator.ts      # Morning briefing generation with Claude Sonnet
│   └── briefing/
│       └── sender.ts         # Send briefing email via Gmail API
├── tests/
│   ├── db/
│   │   ├── schema.test.ts
│   │   └── queries.test.ts
│   ├── email/
│   │   ├── classifier.test.ts
│   │   └── actions.test.ts
│   └── briefing/
│       └── generator.test.ts
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── railway.json
├── CLAUDE.md
└── .env.example
```

**Correction — `briefing/sender.ts` path conflict.** The send functionality lives under `briefing/`:

```
src/briefing/
├── generator.ts      # Compose the briefing markdown
└── sender.ts         # Send briefing as email via Gmail API
```

---

## Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.env.example`
- Create: `railway.json`
- Create: `CLAUDE.md`
- Create: `src/config.ts`

- [ ] **Step 1: Initialize package.json**

```bash
cd /Users/robertmcmillan/Documents/Claude/mcsecretary
npm init -y
```

- [ ] **Step 2: Install dependencies**

```bash
npm install @anthropic-ai/sdk @azure/msal-node googleapis better-sqlite3 tsx typescript
npm install -D @types/better-sqlite3 @types/node vitest
```

- [ ] **Step 3: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noUncheckedIndexedAccess": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 4: Create vitest.config.ts**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
  },
});
```

- [ ] **Step 5: Create .env.example**

```env
# Microsoft Graph API (Azure AD App)
AZURE_TENANT_ID=
AZURE_CLIENT_ID=
AZURE_CLIENT_SECRET=
OUTLOOK_USER_EMAIL_1=rob@dearborndenim.com
OUTLOOK_USER_EMAIL_2=robert@mcmillan-manufacturing.com

# Gmail API (OAuth2)
GMAIL_CLIENT_ID=
GMAIL_CLIENT_SECRET=
GMAIL_REFRESH_TOKEN=
GMAIL_USER_EMAIL=mcmillanrken@gmail.com

# Anthropic
ANTHROPIC_API_KEY=

# Database
DB_PATH=./data/secretary.db
```

- [ ] **Step 6: Create railway.json**

```json
{
  "build": { "builder": "NIXPACKS" },
  "deploy": {
    "startCommand": "npx tsx src/index.ts",
    "cronSchedule": "0 5 * * *",
    "restartPolicyType": "NEVER"
  }
}
```

- [ ] **Step 7: Create src/config.ts**

```typescript
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
```

- [ ] **Step 8: Create CLAUDE.md**

```markdown
# McSECREtary

AI secretary for Rob McMillan — autonomous email triage + daily briefing.

## Tech
- TypeScript (strict), Node.js, SQLite (better-sqlite3)
- Anthropic SDK: Haiku for classification, Sonnet for briefings
- Microsoft Graph API for Outlook email (2 accounts)
- Gmail API for personal email
- Runs as Railway cron job (5 AM daily)

## Structure
- `src/config.ts` — env var loading
- `src/db/` — SQLite schema + queries
- `src/auth/graph.ts` — MSAL token for Graph API
- `src/email/outlook.ts` — Outlook email fetcher
- `src/email/gmail.ts` — Gmail email fetcher
- `src/email/classifier.ts` — LLM email classification (Haiku)
- `src/email/actions.ts` — label, archive, move emails
- `src/briefing/generator.ts` — morning briefing (Sonnet)
- `src/briefing/sender.ts` — send briefing via Gmail

## Commands
- `npx tsx src/index.ts` — run full triage pipeline
- `npx vitest` — run tests
- `npx vitest run` — run tests once (CI)

## Accounts
- rob@dearborndenim.com (Outlook/Exchange)
- robert@mcmillan-manufacturing.com (Outlook/Exchange)
- mcmillanrken@gmail.com (Gmail)
```

- [ ] **Step 9: Add scripts to package.json**

Add to `package.json`:
```json
{
  "scripts": {
    "start": "tsx src/index.ts",
    "test": "vitest",
    "test:run": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "type": "module"
}
```

- [ ] **Step 10: Create data directory with .gitkeep**

```bash
mkdir -p data
touch data/.gitkeep
```

- [ ] **Step 11: Create .gitignore**

```
node_modules/
dist/
data/*.db
.env
```

- [ ] **Step 12: Initialize git and commit**

```bash
git init
git add -A
git commit -m "chore: scaffold mcsecretary project with deps and config"
```

---

## Task 2: SQLite Schema + Query Helpers

**Files:**
- Create: `src/db/schema.ts`
- Create: `src/db/queries.ts`
- Create: `tests/db/schema.test.ts`
- Create: `tests/db/queries.test.ts`

- [ ] **Step 1: Write the schema test**

Create `tests/db/schema.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';

describe('initializeSchema', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('creates all required tables', () => {
    initializeSchema(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain('processed_emails');
    expect(tableNames).toContain('sender_profiles');
    expect(tableNames).toContain('agent_runs');
    expect(tableNames).toContain('audit_log');
  });

  it('is idempotent — running twice does not throw', () => {
    initializeSchema(db);
    expect(() => initializeSchema(db)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/robertmcmillan/Documents/Claude/mcsecretary
npx vitest run tests/db/schema.test.ts
```

Expected: FAIL — `initializeSchema` not found.

- [ ] **Step 3: Implement schema.ts**

Create `src/db/schema.ts`:

```typescript
import type Database from 'better-sqlite3';

export function initializeSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS processed_emails (
      id TEXT PRIMARY KEY,
      account TEXT NOT NULL,
      sender TEXT,
      sender_name TEXT,
      subject TEXT,
      received_at TEXT,
      processed_at TEXT DEFAULT (datetime('now')),
      category TEXT,
      urgency TEXT,
      action_needed TEXT,
      action_taken TEXT,
      confidence REAL,
      summary TEXT,
      thread_id TEXT,
      project_id TEXT
    );

    CREATE TABLE IF NOT EXISTS sender_profiles (
      email TEXT PRIMARY KEY,
      name TEXT,
      organization TEXT,
      default_category TEXT,
      default_urgency TEXT,
      total_emails INTEGER DEFAULT 0,
      last_seen TEXT,
      is_vip INTEGER DEFAULT 0,
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS agent_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT,
      completed_at TEXT,
      run_type TEXT,
      emails_processed INTEGER DEFAULT 0,
      actions_taken INTEGER DEFAULT 0,
      errors TEXT,
      tokens_used INTEGER DEFAULT 0,
      cost_estimate REAL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT DEFAULT (datetime('now')),
      action_type TEXT,
      target_id TEXT,
      target_type TEXT,
      details TEXT,
      confidence REAL,
      approved_by TEXT,
      was_reversed INTEGER DEFAULT 0
    );
  `);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/db/schema.test.ts
```

Expected: PASS

- [ ] **Step 5: Write the queries test**

Create `tests/db/queries.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import {
  insertProcessedEmail,
  getOrCreateSenderProfile,
  updateSenderProfile,
  insertAgentRun,
  completeAgentRun,
  insertAuditLog,
  getEmailsSinceLastRun,
  type ProcessedEmail,
} from '../../src/db/queries.js';

describe('queries', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('insertProcessedEmail', () => {
    it('inserts an email record and retrieves it', () => {
      const email: ProcessedEmail = {
        id: 'msg-123',
        account: 'outlook',
        sender: 'alice@example.com',
        sender_name: 'Alice',
        subject: 'Hello',
        received_at: '2026-04-03T05:00:00Z',
        category: 'customer_inquiry',
        urgency: 'high',
        action_needed: 'reply_required',
        action_taken: 'drafted_reply',
        confidence: 0.95,
        summary: 'Customer asking about bulk order',
        thread_id: 'thread-1',
      };

      insertProcessedEmail(db, email);

      const row = db.prepare('SELECT * FROM processed_emails WHERE id = ?').get('msg-123') as any;
      expect(row.sender).toBe('alice@example.com');
      expect(row.category).toBe('customer_inquiry');
      expect(row.confidence).toBe(0.95);
    });
  });

  describe('getOrCreateSenderProfile', () => {
    it('creates a new profile for unknown sender', () => {
      const profile = getOrCreateSenderProfile(db, 'bob@example.com', 'Bob');
      expect(profile.email).toBe('bob@example.com');
      expect(profile.name).toBe('Bob');
      expect(profile.total_emails).toBe(0);
    });

    it('returns existing profile for known sender', () => {
      getOrCreateSenderProfile(db, 'bob@example.com', 'Bob');
      const profile = getOrCreateSenderProfile(db, 'bob@example.com', 'Bob');
      expect(profile.email).toBe('bob@example.com');
    });
  });

  describe('updateSenderProfile', () => {
    it('increments email count and updates last_seen', () => {
      getOrCreateSenderProfile(db, 'bob@example.com', 'Bob');
      updateSenderProfile(db, 'bob@example.com', 'customer_inquiry', 'high');

      const row = db.prepare('SELECT * FROM sender_profiles WHERE email = ?').get('bob@example.com') as any;
      expect(row.total_emails).toBe(1);
      expect(row.default_category).toBe('customer_inquiry');
    });
  });

  describe('agent runs', () => {
    it('inserts and completes a run', () => {
      const runId = insertAgentRun(db, 'overnight');
      completeAgentRun(db, runId, { emails_processed: 42, actions_taken: 10, tokens_used: 50000, cost_estimate: 1.5 });

      const row = db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(runId) as any;
      expect(row.emails_processed).toBe(42);
      expect(row.completed_at).not.toBeNull();
    });
  });

  describe('insertAuditLog', () => {
    it('logs an action', () => {
      insertAuditLog(db, {
        action_type: 'classify',
        target_id: 'msg-123',
        target_type: 'email',
        details: JSON.stringify({ category: 'junk' }),
        confidence: 0.99,
      });

      const row = db.prepare('SELECT * FROM audit_log WHERE target_id = ?').get('msg-123') as any;
      expect(row.action_type).toBe('classify');
      expect(row.confidence).toBe(0.99);
    });
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

```bash
npx vitest run tests/db/queries.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 7: Implement queries.ts**

Create `src/db/queries.ts`:

```typescript
import type Database from 'better-sqlite3';

export interface ProcessedEmail {
  id: string;
  account: string;
  sender: string;
  sender_name: string;
  subject: string;
  received_at: string;
  category: string;
  urgency: string;
  action_needed: string;
  action_taken: string;
  confidence: number;
  summary: string;
  thread_id: string;
  project_id?: string;
}

export interface SenderProfile {
  email: string;
  name: string | null;
  organization: string | null;
  default_category: string | null;
  default_urgency: string | null;
  total_emails: number;
  last_seen: string | null;
  is_vip: number;
  notes: string | null;
}

export function insertProcessedEmail(db: Database.Database, email: ProcessedEmail): void {
  db.prepare(`
    INSERT OR REPLACE INTO processed_emails
    (id, account, sender, sender_name, subject, received_at, category, urgency, action_needed, action_taken, confidence, summary, thread_id, project_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    email.id, email.account, email.sender, email.sender_name, email.subject,
    email.received_at, email.category, email.urgency, email.action_needed,
    email.action_taken, email.confidence, email.summary, email.thread_id,
    email.project_id ?? null
  );
}

export function getOrCreateSenderProfile(db: Database.Database, email: string, name: string | null): SenderProfile {
  const existing = db.prepare('SELECT * FROM sender_profiles WHERE email = ?').get(email) as SenderProfile | undefined;
  if (existing) return existing;

  db.prepare('INSERT INTO sender_profiles (email, name) VALUES (?, ?)').run(email, name);
  return db.prepare('SELECT * FROM sender_profiles WHERE email = ?').get(email) as SenderProfile;
}

export function updateSenderProfile(
  db: Database.Database,
  email: string,
  category: string,
  urgency: string,
): void {
  db.prepare(`
    UPDATE sender_profiles
    SET total_emails = total_emails + 1,
        last_seen = datetime('now'),
        default_category = ?,
        default_urgency = ?
    WHERE email = ?
  `).run(category, urgency, email);
}

export function insertAgentRun(db: Database.Database, runType: string): number {
  const result = db.prepare(`
    INSERT INTO agent_runs (started_at, run_type)
    VALUES (datetime('now'), ?)
  `).run(runType);
  return Number(result.lastInsertRowid);
}

export function completeAgentRun(
  db: Database.Database,
  runId: number,
  stats: { emails_processed: number; actions_taken: number; tokens_used: number; cost_estimate: number },
): void {
  db.prepare(`
    UPDATE agent_runs
    SET completed_at = datetime('now'),
        emails_processed = ?,
        actions_taken = ?,
        tokens_used = ?,
        cost_estimate = ?
    WHERE id = ?
  `).run(stats.emails_processed, stats.actions_taken, stats.tokens_used, stats.cost_estimate, runId);
}

export function insertAuditLog(
  db: Database.Database,
  entry: {
    action_type: string;
    target_id: string;
    target_type: string;
    details: string;
    confidence: number;
    approved_by?: string;
  },
): void {
  db.prepare(`
    INSERT INTO audit_log (action_type, target_id, target_type, details, confidence, approved_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(entry.action_type, entry.target_id, entry.target_type, entry.details, entry.confidence, entry.approved_by ?? null);
}

export function getLastRunTimestamp(db: Database.Database, runType: string): string | null {
  const row = db.prepare(`
    SELECT completed_at FROM agent_runs
    WHERE run_type = ? AND completed_at IS NOT NULL
    ORDER BY completed_at DESC
    LIMIT 1
  `).get(runType) as { completed_at: string } | undefined;
  return row?.completed_at ?? null;
}
```

- [ ] **Step 8: Run tests to verify they pass**

```bash
npx vitest run tests/db/
```

Expected: All PASS

- [ ] **Step 9: Commit**

```bash
git add src/db/ tests/db/
git commit -m "feat: add SQLite schema and typed query helpers"
```

---

## Task 3: Microsoft Graph Authentication

**Files:**
- Create: `src/auth/graph.ts`

This module uses MSAL client-credentials flow to get an access token for Microsoft Graph API. No user interaction needed — the Azure app has application-level permissions.

- [ ] **Step 1: Implement graph.ts**

Create `src/auth/graph.ts`:

```typescript
import { ConfidentialClientApplication } from '@azure/msal-node';
import { config } from '../config.js';

let msalClient: ConfidentialClientApplication | null = null;

function getMsalClient(): ConfidentialClientApplication {
  if (!msalClient) {
    msalClient = new ConfidentialClientApplication({
      auth: {
        clientId: config.azure.clientId,
        clientSecret: config.azure.clientSecret,
        authority: `https://login.microsoftonline.com/${config.azure.tenantId}`,
      },
    });
  }
  return msalClient;
}

export async function getGraphToken(): Promise<string> {
  const client = getMsalClient();
  const result = await client.acquireTokenByClientCredential({
    scopes: ['https://graph.microsoft.com/.default'],
  });

  if (!result?.accessToken) {
    throw new Error('Failed to acquire Microsoft Graph access token');
  }

  return result.accessToken;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/auth/
git commit -m "feat: add MSAL client-credentials auth for Graph API"
```

---

## Task 4: Outlook Email Fetcher

**Files:**
- Create: `src/email/outlook.ts`
- Create: `src/email/types.ts`

- [ ] **Step 1: Create shared email types**

Create `src/email/types.ts`:

```typescript
export interface RawEmail {
  id: string;
  account: string;
  sender: string;
  senderName: string;
  subject: string;
  bodyPreview: string;
  body: string;
  receivedAt: string;
  threadId: string;
  isRead: boolean;
}

export interface ClassifiedEmail extends RawEmail {
  category: string;
  urgency: string;
  actionNeeded: string;
  confidence: number;
  summary: string;
  suggestedAction: string;
  senderImportance: string;
}
```

- [ ] **Step 2: Implement outlook.ts**

Create `src/email/outlook.ts`:

```typescript
import { getGraphToken } from '../auth/graph.js';
import type { RawEmail } from './types.js';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

interface GraphMessage {
  id: string;
  from: { emailAddress: { address: string; name: string } };
  subject: string;
  bodyPreview: string;
  body: { content: string; contentType: string };
  receivedDateTime: string;
  conversationId: string;
  isRead: boolean;
}

interface GraphResponse {
  value: GraphMessage[];
  '@odata.nextLink'?: string;
}

export async function fetchUnreadOutlookEmails(
  userEmail: string,
  since: string | null,
  maxResults: number = 50,
): Promise<RawEmail[]> {
  const token = await getGraphToken();

  let filter = 'isRead eq false';
  if (since) {
    filter += ` and receivedDateTime ge ${since}`;
  }

  const url = `${GRAPH_BASE}/users/${userEmail}/messages?$filter=${encodeURIComponent(filter)}&$top=${maxResults}&$orderby=receivedDateTime desc&$select=id,from,subject,bodyPreview,body,receivedDateTime,conversationId,isRead`;

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Graph API error (${response.status}): ${text}`);
  }

  const data = (await response.json()) as GraphResponse;

  return data.value.map((msg): RawEmail => ({
    id: msg.id,
    account: userEmail,
    sender: msg.from.emailAddress.address,
    senderName: msg.from.emailAddress.name,
    subject: msg.subject,
    bodyPreview: msg.bodyPreview,
    body: stripHtml(msg.body.content),
    receivedAt: msg.receivedDateTime,
    threadId: msg.conversationId,
    isRead: msg.isRead,
  }));
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 3000);
}
```

- [ ] **Step 3: Commit**

```bash
git add src/email/types.ts src/email/outlook.ts
git commit -m "feat: add Outlook email fetcher via Graph API"
```

---

## Task 5: Gmail Email Fetcher

**Files:**
- Create: `src/email/gmail.ts`

- [ ] **Step 1: Implement gmail.ts**

Create `src/email/gmail.ts`:

```typescript
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
    // Prefer text/plain, fall back to text/html stripped
    const textPart = payload.parts.find((p: any) => p.mimeType === 'text/plain');
    if (textPart?.body?.data) {
      return Buffer.from(textPart.body.data, 'base64url').toString('utf-8');
    }

    const htmlPart = payload.parts.find((p: any) => p.mimeType === 'text/html');
    if (htmlPart?.body?.data) {
      const html = Buffer.from(htmlPart.body.data, 'base64url').toString('utf-8');
      return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }

    // Recurse into nested multipart
    for (const part of payload.parts) {
      const result = extractBody(part);
      if (result) return result;
    }
  }

  return '';
}
```

- [ ] **Step 2: Commit**

```bash
git add src/email/gmail.ts
git commit -m "feat: add Gmail email fetcher via googleapis"
```

---

## Task 6: Email Classifier (Claude Haiku)

**Files:**
- Create: `src/email/classifier.ts`
- Create: `tests/email/classifier.test.ts`

- [ ] **Step 1: Write the classifier test**

Create `tests/email/classifier.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildClassificationPrompt, parseClassificationResponse } from '../../src/email/classifier.js';
import type { RawEmail } from '../../src/email/types.js';

const sampleEmail: RawEmail = {
  id: 'msg-1',
  account: 'rob@dearborndenim.com',
  sender: 'alice@fabricco.com',
  senderName: 'Alice Johnson',
  subject: 'Sample fabric pricing for fall collection',
  bodyPreview: 'Hi Rob, here are the prices for the denim rolls...',
  body: 'Hi Rob,\n\nHere are the prices for the denim rolls we discussed:\n- 12oz selvedge: $4.50/yard\n- 10oz stretch: $3.80/yard\n\nLet me know if you want to proceed with an order.\n\nBest,\nAlice',
  receivedAt: '2026-04-03T14:00:00Z',
  threadId: 'thread-1',
  isRead: false,
};

describe('buildClassificationPrompt', () => {
  it('includes sender, subject, and body in the prompt', () => {
    const prompt = buildClassificationPrompt(sampleEmail);
    expect(prompt).toContain('alice@fabricco.com');
    expect(prompt).toContain('Sample fabric pricing');
    expect(prompt).toContain('12oz selvedge');
  });

  it('includes the account info', () => {
    const prompt = buildClassificationPrompt(sampleEmail);
    expect(prompt).toContain('rob@dearborndenim.com');
  });
});

describe('parseClassificationResponse', () => {
  it('parses valid JSON classification', () => {
    const raw = JSON.stringify({
      category: 'supplier',
      urgency: 'medium',
      action_needed: 'review_required',
      confidence: 0.91,
      summary: 'Fabric supplier sending pricing for denim rolls',
      suggested_action: 'Review pricing and compare to current supplier rates',
      sender_importance: 'vendor',
    });

    const result = parseClassificationResponse(raw);
    expect(result.category).toBe('supplier');
    expect(result.urgency).toBe('medium');
    expect(result.confidence).toBe(0.91);
  });

  it('handles JSON wrapped in markdown code fences', () => {
    const raw = '```json\n{"category":"junk","urgency":"low","action_needed":"archive","confidence":0.98,"summary":"Spam","suggested_action":"Archive","sender_importance":"unknown"}\n```';
    const result = parseClassificationResponse(raw);
    expect(result.category).toBe('junk');
  });

  it('returns fallback for unparseable response', () => {
    const result = parseClassificationResponse('this is not json');
    expect(result.category).toBe('unknown');
    expect(result.confidence).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/email/classifier.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement classifier.ts**

Create `src/email/classifier.ts`:

```typescript
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import type { RawEmail, ClassifiedEmail } from './types.js';

const SYSTEM_PROMPT = `You are an email triage assistant for Robert McMillan, who owns:
- Dearborn Denim (rob@dearborndenim.com) — a denim/jeans company
- McMillan Manufacturing (robert@mcmillan-manufacturing.com) — contract manufacturing

Your job is to classify incoming emails. Respond with ONLY a JSON object (no markdown, no explanation):

{
  "category": "customer_inquiry | order_related | supplier | team_internal | financial | newsletter | promotional | transactional | personal | junk",
  "urgency": "critical | high | medium | low",
  "action_needed": "reply_required | review_required | fyi_only | archive | delete",
  "confidence": 0.0-1.0,
  "summary": "One sentence summary of the email",
  "suggested_action": "What Rob should do about this",
  "sender_importance": "returning_customer | new_customer | vendor | employee | bank | personal | unknown"
}

Category guidance:
- customer_inquiry: Questions about products, sizing, orders, samples. Always high priority.
- order_related: Shopify notifications, shipping, fulfillment. Medium priority.
- supplier: Fabric suppliers, manufacturers, logistics. High if delivery/pricing related.
- team_internal: Messages from employees or contractors.
- financial: Bank, payments, invoices, tax. Review required.
- newsletter/promotional: Industry news, marketing, vendor promos. FYI or archive.
- transactional: Password resets, SaaS billing, service notifications. Low priority.
- personal: Family, friends. Flag but separate from business.
- junk: Spam, phishing, irrelevant solicitations. Archive.`;

export function buildClassificationPrompt(email: RawEmail): string {
  return `Classify this email:

From: ${email.senderName} <${email.sender}>
To: ${email.account}
Subject: ${email.subject}
Date: ${email.receivedAt}

Body:
${email.body}`;
}

export interface Classification {
  category: string;
  urgency: string;
  action_needed: string;
  confidence: number;
  summary: string;
  suggested_action: string;
  sender_importance: string;
}

export function parseClassificationResponse(raw: string): Classification {
  const fallback: Classification = {
    category: 'unknown',
    urgency: 'low',
    action_needed: 'review_required',
    confidence: 0,
    summary: 'Failed to classify',
    suggested_action: 'Review manually',
    sender_importance: 'unknown',
  };

  try {
    // Strip markdown code fences if present
    const cleaned = raw.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
    const parsed = JSON.parse(cleaned);

    return {
      category: parsed.category ?? fallback.category,
      urgency: parsed.urgency ?? fallback.urgency,
      action_needed: parsed.action_needed ?? fallback.action_needed,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
      summary: parsed.summary ?? fallback.summary,
      suggested_action: parsed.suggested_action ?? fallback.suggested_action,
      sender_importance: parsed.sender_importance ?? fallback.sender_importance,
    };
  } catch {
    return fallback;
  }
}

let anthropicClient: Anthropic | null = null;

function getAnthropicClient(): Anthropic {
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ apiKey: config.anthropic.apiKey });
  }
  return anthropicClient;
}

export async function classifyEmail(email: RawEmail): Promise<ClassifiedEmail> {
  const client = getAnthropicClient();
  const prompt = buildClassificationPrompt(email);

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');

  const classification = parseClassificationResponse(text);

  return {
    ...email,
    category: classification.category,
    urgency: classification.urgency,
    actionNeeded: classification.action_needed,
    confidence: classification.confidence,
    summary: classification.summary,
    suggestedAction: classification.suggested_action,
    senderImportance: classification.sender_importance,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/email/classifier.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/email/classifier.ts tests/email/classifier.test.ts
git commit -m "feat: add email classifier with Claude Haiku"
```

---

## Task 7: Email Actions (Label, Archive, Move)

**Files:**
- Create: `src/email/actions.ts`
- Create: `tests/email/actions.test.ts`

- [ ] **Step 1: Write the actions test**

Create `tests/email/actions.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { determineAction, type EmailAction } from '../../src/email/actions.js';
import type { ClassifiedEmail } from '../../src/email/types.js';

function makeClassified(overrides: Partial<ClassifiedEmail>): ClassifiedEmail {
  return {
    id: 'msg-1',
    account: 'rob@dearborndenim.com',
    sender: 'test@example.com',
    senderName: 'Test',
    subject: 'Test',
    bodyPreview: 'Test',
    body: 'Test',
    receivedAt: '2026-04-03T05:00:00Z',
    threadId: 'thread-1',
    isRead: false,
    category: 'customer_inquiry',
    urgency: 'high',
    actionNeeded: 'reply_required',
    confidence: 0.95,
    summary: 'Test email',
    suggestedAction: 'Reply',
    senderImportance: 'new_customer',
    ...overrides,
  };
}

describe('determineAction', () => {
  it('archives junk with high confidence', () => {
    const email = makeClassified({ category: 'junk', confidence: 0.96 });
    const action = determineAction(email);
    expect(action.type).toBe('archive');
  });

  it('archives newsletters/promotional', () => {
    const email = makeClassified({ category: 'newsletter', actionNeeded: 'archive' });
    const action = determineAction(email);
    expect(action.type).toBe('archive');
  });

  it('flags customer inquiries for review', () => {
    const email = makeClassified({ category: 'customer_inquiry', urgency: 'high' });
    const action = determineAction(email);
    expect(action.type).toBe('flag_for_review');
  });

  it('marks transactional as read only', () => {
    const email = makeClassified({ category: 'transactional', actionNeeded: 'fyi_only' });
    const action = determineAction(email);
    expect(action.type).toBe('mark_read');
  });

  it('does not archive low-confidence junk', () => {
    const email = makeClassified({ category: 'junk', confidence: 0.6 });
    const action = determineAction(email);
    expect(action.type).toBe('flag_for_review');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/email/actions.test.ts
```

Expected: FAIL

- [ ] **Step 3: Implement actions.ts**

Create `src/email/actions.ts`:

```typescript
import { getGraphToken } from '../auth/graph.js';
import type { ClassifiedEmail } from './types.js';

export interface EmailAction {
  type: 'archive' | 'mark_read' | 'flag_for_review' | 'no_action';
  reason: string;
}

const AUTO_ARCHIVE_CATEGORIES = new Set(['junk', 'newsletter', 'promotional']);
const HIGH_CONFIDENCE_THRESHOLD = 0.9;

export function determineAction(email: ClassifiedEmail): EmailAction {
  // Auto-archive junk/newsletters only with high confidence
  if (AUTO_ARCHIVE_CATEGORIES.has(email.category)) {
    if (email.confidence >= HIGH_CONFIDENCE_THRESHOLD || email.actionNeeded === 'archive') {
      return { type: 'archive', reason: `Auto-archive ${email.category} (confidence: ${email.confidence})` };
    }
    // Low confidence junk — flag for manual review
    return { type: 'flag_for_review', reason: `Low confidence ${email.category} — needs manual review` };
  }

  // Transactional FYI — just mark as read
  if (email.category === 'transactional' && email.actionNeeded === 'fyi_only') {
    return { type: 'mark_read', reason: 'Transactional FYI — marked as read' };
  }

  // Everything else: flag for Rob to review in the briefing
  if (email.actionNeeded === 'reply_required' || email.urgency === 'critical' || email.urgency === 'high') {
    return { type: 'flag_for_review', reason: `${email.category} — needs attention (${email.urgency})` };
  }

  return { type: 'flag_for_review', reason: `${email.category} — included in briefing` };
}

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

export async function archiveOutlookEmail(userEmail: string, messageId: string): Promise<void> {
  const token = await getGraphToken();

  // Move to Archive folder
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
  const token = await getGraphToken();

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
  const token = await getGraphToken();

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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/email/actions.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/email/actions.ts tests/email/actions.test.ts
git commit -m "feat: add email action routing and Outlook API actions"
```

---

## Task 8: Briefing Generator (Claude Sonnet)

**Files:**
- Create: `src/briefing/generator.ts`
- Create: `tests/briefing/generator.test.ts`

- [ ] **Step 1: Write the generator test**

Create `tests/briefing/generator.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildBriefingPrompt } from '../../src/briefing/generator.js';
import type { ClassifiedEmail } from '../../src/email/types.js';

function makeClassified(overrides: Partial<ClassifiedEmail>): ClassifiedEmail {
  return {
    id: 'msg-1',
    account: 'rob@dearborndenim.com',
    sender: 'test@example.com',
    senderName: 'Test',
    subject: 'Test Subject',
    bodyPreview: 'Test body',
    body: 'Test body content',
    receivedAt: '2026-04-03T05:00:00Z',
    threadId: 'thread-1',
    isRead: false,
    category: 'customer_inquiry',
    urgency: 'high',
    actionNeeded: 'reply_required',
    confidence: 0.95,
    summary: 'Customer asking about bulk order',
    suggestedAction: 'Draft reply with pricing',
    senderImportance: 'new_customer',
    ...overrides,
  };
}

describe('buildBriefingPrompt', () => {
  it('groups emails by urgency in the prompt', () => {
    const emails = [
      makeClassified({ id: '1', urgency: 'critical', summary: 'Urgent customer issue' }),
      makeClassified({ id: '2', urgency: 'low', category: 'newsletter', summary: 'Industry news' }),
      makeClassified({ id: '3', urgency: 'high', summary: 'Supplier pricing update' }),
    ];

    const prompt = buildBriefingPrompt(emails, {
      totalProcessed: 50,
      archived: 30,
      flaggedForReview: 20,
    });

    expect(prompt).toContain('Urgent customer issue');
    expect(prompt).toContain('Supplier pricing update');
    expect(prompt).toContain('50');
  });

  it('includes stats in the prompt', () => {
    const prompt = buildBriefingPrompt([], {
      totalProcessed: 10,
      archived: 8,
      flaggedForReview: 2,
    });

    expect(prompt).toContain('10');
    expect(prompt).toContain('8');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/briefing/generator.test.ts
```

Expected: FAIL

- [ ] **Step 3: Implement generator.ts**

Create `src/briefing/generator.ts`:

```typescript
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import type { ClassifiedEmail } from '../email/types.js';

const BRIEFING_SYSTEM_PROMPT = `You are Rob McMillan's AI secretary generating his morning briefing.

Rob owns Dearborn Denim (rob@dearborndenim.com) and McMillan Manufacturing (robert@mcmillan-manufacturing.com). His personal email is mcmillanrken@gmail.com.

Generate a concise, actionable morning briefing in markdown format. Structure:

1. **Needs Your Attention** — Critical/high urgency items requiring a response. Include sender, one-line summary, and suggested action.
2. **For Your Review** — Medium priority items to look at when time allows.
3. **FYI / Handled** — What was auto-archived or marked as informational.
4. **Stats** — How many emails processed, archived, flagged.

Keep it conversational but direct. Rob is busy — lead with what matters.
Don't use emoji.`;

export interface BriefingStats {
  totalProcessed: number;
  archived: number;
  flaggedForReview: number;
}

export function buildBriefingPrompt(
  emails: ClassifiedEmail[],
  stats: BriefingStats,
): string {
  const critical = emails.filter((e) => e.urgency === 'critical');
  const high = emails.filter((e) => e.urgency === 'high');
  const medium = emails.filter((e) => e.urgency === 'medium');
  const low = emails.filter((e) => e.urgency === 'low');

  const formatEmails = (list: ClassifiedEmail[]): string =>
    list.length === 0
      ? 'None'
      : list
          .map(
            (e) =>
              `- From: ${e.senderName} <${e.sender}> (${e.account})\n  Subject: ${e.subject}\n  Summary: ${e.summary}\n  Suggested action: ${e.suggestedAction}`,
          )
          .join('\n');

  return `Generate the morning briefing for today.

Stats:
- Total emails processed: ${stats.totalProcessed}
- Auto-archived: ${stats.archived}
- Flagged for review: ${stats.flaggedForReview}

CRITICAL urgency:
${formatEmails(critical)}

HIGH urgency:
${formatEmails(high)}

MEDIUM urgency:
${formatEmails(medium)}

LOW urgency:
${formatEmails(low)}`;
}

let anthropicClient: Anthropic | null = null;

function getAnthropicClient(): Anthropic {
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ apiKey: config.anthropic.apiKey });
  }
  return anthropicClient;
}

export async function generateBriefing(
  emails: ClassifiedEmail[],
  stats: BriefingStats,
): Promise<string> {
  const client = getAnthropicClient();
  const prompt = buildBriefingPrompt(emails, stats);

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6-20250514',
    max_tokens: 2000,
    system: BRIEFING_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: prompt }],
  });

  return response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/briefing/generator.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/briefing/generator.ts tests/briefing/generator.test.ts
git commit -m "feat: add morning briefing generator with Claude Sonnet"
```

---

## Task 9: Briefing Email Sender

**Files:**
- Create: `src/briefing/sender.ts`

- [ ] **Step 1: Implement sender.ts**

Create `src/briefing/sender.ts`:

```typescript
import { google } from 'googleapis';
import { config } from '../config.js';

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

export async function sendBriefingEmail(briefingMarkdown: string): Promise<void> {
  const gmail = getGmailClient();

  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'America/Chicago',
  });

  const subject = `Morning Briefing — ${today}`;

  // Build raw RFC 2822 message
  const messageParts = [
    `To: ${config.gmail.userEmail}`,
    `From: ${config.gmail.userEmail}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    briefingMarkdown,
  ];

  const rawMessage = messageParts.join('\n');
  const encodedMessage = Buffer.from(rawMessage)
    .toString('base64url');

  await gmail.users.messages.send({
    userId: 'me',
    requestBody: {
      raw: encodedMessage,
    },
  });

  console.log(`Briefing email sent: "${subject}"`);
}
```

- [ ] **Step 2: Commit**

```bash
git add src/briefing/sender.ts
git commit -m "feat: add briefing email sender via Gmail API"
```

---

## Task 10: Main Orchestrator (index.ts)

**Files:**
- Create: `src/index.ts`

- [ ] **Step 1: Implement index.ts**

Create `src/index.ts`:

```typescript
import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { config } from './config.js';
import { initializeSchema } from './db/schema.js';
import {
  insertProcessedEmail,
  getOrCreateSenderProfile,
  updateSenderProfile,
  insertAgentRun,
  completeAgentRun,
  insertAuditLog,
  getLastRunTimestamp,
} from './db/queries.js';
import { fetchUnreadOutlookEmails } from './email/outlook.js';
import { fetchUnreadGmailEmails } from './email/gmail.js';
import { classifyEmail } from './email/classifier.js';
import { determineAction, archiveOutlookEmail, markOutlookAsRead, categorizeOutlookEmail } from './email/actions.js';
import { generateBriefing } from './briefing/generator.js';
import { sendBriefingEmail } from './briefing/sender.js';
import type { RawEmail, ClassifiedEmail } from './email/types.js';

async function main() {
  console.log('McSECREtary — overnight triage starting...');
  const startTime = Date.now();

  // Ensure data directory exists
  const dbDir = path.dirname(config.db.path);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  // Initialize database
  const db = new Database(config.db.path);
  db.pragma('journal_mode = WAL');
  initializeSchema(db);

  // Start run tracking
  const runId = insertAgentRun(db, 'overnight');
  const lastRun = getLastRunTimestamp(db, 'overnight');

  let totalProcessed = 0;
  let totalArchived = 0;
  let totalFlagged = 0;
  const allClassified: ClassifiedEmail[] = [];
  const errors: string[] = [];

  try {
    // 1. Fetch emails from all accounts
    console.log('Fetching emails...');

    const [outlook1, outlook2, gmail] = await Promise.all([
      fetchUnreadOutlookEmails(config.outlook.email1, lastRun).catch((err) => {
        errors.push(`Outlook1 fetch failed: ${err.message}`);
        return [] as RawEmail[];
      }),
      fetchUnreadOutlookEmails(config.outlook.email2, lastRun).catch((err) => {
        errors.push(`Outlook2 fetch failed: ${err.message}`);
        return [] as RawEmail[];
      }),
      fetchUnreadGmailEmails(lastRun).catch((err) => {
        errors.push(`Gmail fetch failed: ${err.message}`);
        return [] as RawEmail[];
      }),
    ]);

    const allEmails = [...outlook1, ...outlook2, ...gmail];
    console.log(`Fetched ${allEmails.length} unread emails (${outlook1.length} OL1, ${outlook2.length} OL2, ${gmail.length} Gmail)`);

    // 2. Classify each email
    console.log('Classifying emails...');
    for (const email of allEmails) {
      try {
        const classified = await classifyEmail(email);
        allClassified.push(classified);

        // 3. Update sender profile
        const sender = getOrCreateSenderProfile(db, classified.sender, classified.senderName);
        updateSenderProfile(db, classified.sender, classified.category, classified.urgency);

        // 4. Determine and execute action
        const action = determineAction(classified);

        if (action.type === 'archive' && classified.account !== config.gmail.userEmail) {
          await archiveOutlookEmail(classified.account, classified.id);
          totalArchived++;
        } else if (action.type === 'mark_read' && classified.account !== config.gmail.userEmail) {
          await markOutlookAsRead(classified.account, classified.id);
        }

        if (action.type === 'flag_for_review') {
          totalFlagged++;
        }

        // Categorize Outlook emails
        if (classified.account !== config.gmail.userEmail) {
          await categorizeOutlookEmail(classified.account, classified.id, classified.category).catch(() => {
            // Category might not exist yet — non-critical
          });
        }

        // 5. Store in database
        insertProcessedEmail(db, {
          id: classified.id,
          account: classified.account,
          sender: classified.sender,
          sender_name: classified.senderName,
          subject: classified.subject,
          received_at: classified.receivedAt,
          category: classified.category,
          urgency: classified.urgency,
          action_needed: classified.actionNeeded,
          action_taken: action.type,
          confidence: classified.confidence,
          summary: classified.summary,
          thread_id: classified.threadId,
        });

        insertAuditLog(db, {
          action_type: action.type,
          target_id: classified.id,
          target_type: 'email',
          details: JSON.stringify({ category: classified.category, urgency: classified.urgency, reason: action.reason }),
          confidence: classified.confidence,
        });

        totalProcessed++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Failed to process email ${email.id}: ${msg}`);
      }
    }

    // 6. Generate and send morning briefing
    console.log('Generating morning briefing...');
    const briefing = await generateBriefing(allClassified, {
      totalProcessed,
      archived: totalArchived,
      flaggedForReview: totalFlagged,
    });

    console.log('Sending briefing email...');
    await sendBriefingEmail(briefing);

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Fatal error: ${msg}`);
    console.error('Fatal error:', msg);
  }

  // 7. Complete run tracking
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  completeAgentRun(db, runId, {
    emails_processed: totalProcessed,
    actions_taken: totalArchived + totalFlagged,
    tokens_used: 0, // TODO: track from API responses
    cost_estimate: 0,
  });

  if (errors.length > 0) {
    console.warn(`Completed with ${errors.length} errors:`, errors);
  }

  console.log(`McSECREtary run complete in ${elapsed}s — ${totalProcessed} emails processed, ${totalArchived} archived, ${totalFlagged} flagged`);

  db.close();
}

main().catch((err) => {
  console.error('McSECREtary crashed:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Install dotenv dependency**

```bash
npm install dotenv
```

- [ ] **Step 3: Commit**

```bash
git add src/index.ts package.json package-lock.json
git commit -m "feat: add main orchestrator — full overnight triage pipeline"
```

---

## Task 11: Create .env from existing credentials + verify typecheck

**Files:**
- Create: `.env` (local only, gitignored)

- [ ] **Step 1: Create .env from existing credentials**

Copy credentials from `Projects/Claude Cowork Setup/.env.azure` into `.env` with the correct variable names. The Gmail credentials (OAuth client ID, secret, refresh token) need to be obtained separately — Rob needs to set up a Google Cloud project with Gmail API enabled and generate OAuth credentials.

```env
AZURE_TENANT_ID=71b181c1-4d59-4b70-b1c1-d952cb4e984f
AZURE_CLIENT_ID=f29726ad-a76a-4b5a-b0d6-3563dd65427e
AZURE_CLIENT_SECRET=<your-azure-client-secret>
OUTLOOK_USER_EMAIL_1=rob@dearborndenim.com
OUTLOOK_USER_EMAIL_2=robert@mcmillan-manufacturing.com

# Gmail — needs OAuth setup (Google Cloud Console → Gmail API → OAuth2)
GMAIL_CLIENT_ID=
GMAIL_CLIENT_SECRET=
GMAIL_REFRESH_TOKEN=
GMAIL_USER_EMAIL=mcmillanrken@gmail.com

ANTHROPIC_API_KEY=<your-anthropic-api-key>

DB_PATH=./data/secretary.db
```

- [ ] **Step 2: Run typecheck**

```bash
npx tsc --noEmit
```

Expected: No errors (or only errors related to missing type stubs — fix as needed).

- [ ] **Step 3: Run all tests**

```bash
npx vitest run
```

Expected: All tests pass.

- [ ] **Step 4: Commit any typecheck fixes**

```bash
git add -A
git commit -m "chore: fix any type errors and finalize phase 1"
```

---

## Pre-Deployment Checklist

Before deploying to Railway:

- [ ] **Gmail OAuth Setup:** Rob needs to create a Google Cloud project, enable Gmail API, create OAuth2 credentials, and run the consent flow once to get a refresh token. The refresh token goes in `GMAIL_REFRESH_TOKEN`.
- [ ] **Test with real credentials:** Run `npx tsx src/index.ts` locally with real `.env` values to verify the full pipeline works end-to-end.
- [ ] **Railway deployment:** `railway init` → `railway up` → set environment variables in Railway dashboard → enable cron schedule.

---

## What Phase 2 Builds On

Phase 2 (Calendar Unification) adds:
- Google Calendar API fetching to the Railway agent
- Apple Calendar access on Mac Mini
- Conflict detection algorithm
- Calendar summary section in the morning briefing
- Free-slot finder with Rob's scheduling preferences

Phase 2 will be planned separately once Phase 1 is running in production.
