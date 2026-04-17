# McSecretary Multi-User Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make McSecretary serve three users (Robert, Olivier, Merab) with per-user email triage, calendar, briefings, and a request queue for submitting nightly plan items.

**Architecture:** Add a `users` table and `user_id` foreign key to all existing tables. Route Telegram messages by `chat_id` → `user_id`. Loop the triage/briefing pipeline per user. Add a `dev_requests` table for end-user feature requests that queue for Robert's approval before the Foreman picks them up. Single Azure AD app (client credentials), single Telegram bot.

**Tech Stack:** TypeScript (strict), better-sqlite3, grammy, node-cron, Anthropic SDK, Microsoft Graph API (client credentials flow)

---

## File Map

### New Files

| File | Responsibility |
|------|---------------|
| `src/db/user-schema.ts` | CREATE TABLE for `users`, `user_email_accounts`, `user_preferences`, `user_invites`, `dev_requests`. ALTER existing tables to add `user_id`. |
| `src/db/user-queries.ts` | CRUD for users, email accounts, preferences, invites. Lookup user by `telegram_chat_id`. |
| `src/db/request-queries.ts` | CRUD for `dev_requests` table — insert, list pending, approve, reject, list by user. |
| `src/admin.ts` | CLI tool: `add-user`, `add-email`, `set-preferences`, `list-users`, `generate-invite`, `test-briefing`. |
| `tests/db/user-queries.test.ts` | Tests for user CRUD, invite validation, email account management. |
| `tests/db/request-queries.test.ts` | Tests for dev request CRUD, approval flow. |
| `tests/admin.test.ts` | Tests for admin CLI argument parsing and execution. |
| `tests/multi-user/routing.test.ts` | Tests for chat_id → user_id routing, unknown chat rejection, invite linking. |
| `tests/multi-user/triage.test.ts` | Tests for per-user triage pipeline (user-scoped email fetch, classification, briefing). |
| `tests/multi-user/requests.test.ts` | Tests for `/request` command flow, approval in Robert's briefing. |

### Modified Files

| File | What Changes |
|------|-------------|
| `src/db/schema.ts` | Call `initializeUserSchema(db)` after existing schema init. |
| `src/db/queries.ts` | Add `user_id` parameter to all functions. Update SQL to include `user_id` in INSERT/WHERE. |
| `src/db/calendar-queries.ts` | Add `user_id` parameter to all functions. Update SQL. |
| `src/db/conversation-queries.ts` | Add `user_id` parameter to all functions. Update SQL. |
| `src/db/time-queries.ts` | Add `user_id` parameter to all functions. Update SQL. |
| `src/config.ts` | Make `OUTLOOK_USER_EMAIL_1`, `OUTLOOK_USER_EMAIL_2`, `TELEGRAM_CHAT_ID` optional (no longer hardcoded). |
| `src/telegram/bot.ts` | `sendMessage(userId, text)` — accept userId, look up chat_id from DB. Remove global `chatId`. |
| `src/triage.ts` | `runTriage(db, userId)` — fetch only this user's email accounts, scope all DB writes to userId. |
| `src/briefing/generator.ts` | `generateBriefing(...)` — accept `UserPreferences` for dynamic system prompt. |
| `src/index.ts` | Route incoming messages by `chat_id` lookup. Per-user briefing loop. Handle `/start`, `/request`, `/review` commands. |
| `src/scheduler.ts` | Morning briefing loops over all users with `briefing_enabled`. |
| `src/email/outlook.ts` | No changes — already takes email address as param. |
| `src/calendar/outlook-calendar.ts` | No changes — already takes email address as param. |
| `src/tools.ts` | Pass `userId` through to all tool executions that touch DB. |

---

## Task 1: User Schema + Migration

**Files:**
- Create: `src/db/user-schema.ts`
- Modify: `src/db/schema.ts`
- Test: `tests/db/user-queries.test.ts` (schema portion)

- [ ] **Step 1: Write the failing test for user schema creation**

```typescript
// tests/db/user-queries.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';

describe('user schema', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
  });

  it('should create users table', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'")
      .all();
    expect(tables).toHaveLength(1);
  });

  it('should create user_email_accounts table', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='user_email_accounts'")
      .all();
    expect(tables).toHaveLength(1);
  });

  it('should create user_preferences table', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='user_preferences'")
      .all();
    expect(tables).toHaveLength(1);
  });

  it('should create user_invites table', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='user_invites'")
      .all();
    expect(tables).toHaveLength(1);
  });

  it('should create dev_requests table', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='dev_requests'")
      .all();
    expect(tables).toHaveLength(1);
  });

  it('should add user_id column to processed_emails', () => {
    const info = db.prepare('PRAGMA table_info(processed_emails)').all() as { name: string }[];
    const colNames = info.map((c) => c.name);
    expect(colNames).toContain('user_id');
  });

  it('should add user_id column to conversation_log', () => {
    const info = db.prepare('PRAGMA table_info(conversation_log)').all() as { name: string }[];
    const colNames = info.map((c) => c.name);
    expect(colNames).toContain('user_id');
  });

  it('should add user_id column to time_log', () => {
    const info = db.prepare('PRAGMA table_info(time_log)').all() as { name: string }[];
    const colNames = info.map((c) => c.name);
    expect(colNames).toContain('user_id');
  });

  it('should add user_id column to calendar_events', () => {
    const info = db.prepare('PRAGMA table_info(calendar_events)').all() as { name: string }[];
    const colNames = info.map((c) => c.name);
    expect(colNames).toContain('user_id');
  });

  it('should add user_id column to agent_runs', () => {
    const info = db.prepare('PRAGMA table_info(agent_runs)').all() as { name: string }[];
    const colNames = info.map((c) => c.name);
    expect(colNames).toContain('user_id');
  });

  it('should add user_id column to audit_log', () => {
    const info = db.prepare('PRAGMA table_info(audit_log)').all() as { name: string }[];
    const colNames = info.map((c) => c.name);
    expect(colNames).toContain('user_id');
  });

  it('should add user_id column to sender_profiles', () => {
    const info = db.prepare('PRAGMA table_info(sender_profiles)').all() as { name: string }[];
    const colNames = info.map((c) => c.name);
    expect(colNames).toContain('user_id');
  });

  it('should add user_id column to weekly_schedule', () => {
    const info = db.prepare('PRAGMA table_info(weekly_schedule)').all() as { name: string }[];
    const colNames = info.map((c) => c.name);
    expect(colNames).toContain('user_id');
  });

  it('should add user_id column to pending_actions', () => {
    const info = db.prepare('PRAGMA table_info(pending_actions)').all() as { name: string }[];
    const colNames = info.map((c) => c.name);
    expect(colNames).toContain('user_id');
  });

  it('should be idempotent', () => {
    // Running schema init twice should not error
    initializeSchema(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'")
      .all();
    expect(tables).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/robertmcmillan/Documents/claude/claude_code/McSecretary && npx vitest run tests/db/user-queries.test.ts`
Expected: FAIL — `users` table does not exist, `user_id` columns not found

- [ ] **Step 3: Write the user schema**

```typescript
// src/db/user-schema.ts
import type Database from 'better-sqlite3';

export function initializeUserSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      telegram_chat_id TEXT UNIQUE,
      timezone TEXT NOT NULL DEFAULT 'America/Chicago',
      briefing_enabled INTEGER DEFAULT 1,
      briefing_cron TEXT DEFAULT '0 4 * * 1-5',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS user_email_accounts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      email_address TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'outlook',
      enabled INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(user_id, email_address)
    );

    CREATE TABLE IF NOT EXISTS user_preferences (
      user_id TEXT PRIMARY KEY REFERENCES users(id),
      classifier_system_prompt TEXT,
      briefing_system_prompt TEXT,
      business_context TEXT,
      vip_senders TEXT DEFAULT '[]',
      quiet_categories TEXT DEFAULT '["junk","promotional","newsletter"]',
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS user_invites (
      code TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      created_at TEXT DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      used_at TEXT
    );

    CREATE TABLE IF NOT EXISTS dev_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL REFERENCES users(id),
      project TEXT,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      refined_description TEXT,
      reviewed_by TEXT REFERENCES users(id),
      reviewed_at TEXT,
      rejection_reason TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Add user_id to existing tables (idempotent — check before ALTER)
  const tablesToAlter = [
    'processed_emails',
    'sender_profiles',
    'agent_runs',
    'audit_log',
    'calendar_events',
    'weekly_schedule',
    'pending_actions',
    'time_log',
    'conversation_log',
  ];

  for (const table of tablesToAlter) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    const hasUserId = cols.some((c) => c.name === 'user_id');
    if (!hasUserId) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN user_id TEXT REFERENCES users(id)`);
    }
  }
}
```

- [ ] **Step 4: Wire user schema into main schema init**

```typescript
// src/db/schema.ts — add import and call
import type Database from 'better-sqlite3';
import { initializeCalendarSchema } from './calendar-schema.js';
import { initializeUserSchema } from './user-schema.js';

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

  initializeCalendarSchema(db);
  initializeUserSchema(db);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /Users/robertmcmillan/Documents/claude/claude_code/McSecretary && npx vitest run tests/db/user-queries.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Run full test suite for regressions**

Run: `cd /Users/robertmcmillan/Documents/claude/claude_code/McSecretary && npx vitest run`
Expected: All 120 existing tests still pass

- [ ] **Step 7: Commit**

```bash
git add src/db/user-schema.ts src/db/schema.ts tests/db/user-queries.test.ts
git commit -m "feat: add multi-user schema — users, email accounts, preferences, invites, dev requests"
```

---

## Task 2: User CRUD Queries

**Files:**
- Create: `src/db/user-queries.ts`
- Test: `tests/db/user-queries.test.ts` (append to existing)

- [ ] **Step 1: Write failing tests for user CRUD**

Append to `tests/db/user-queries.test.ts`:

```typescript
import {
  createUser,
  getUserById,
  getUserByTelegramChatId,
  getActiveUsers,
  getUserEmailAccounts,
  addEmailAccount,
  getUserPreferences,
  setUserPreferences,
  createInvite,
  consumeInvite,
  linkTelegramChat,
} from '../../src/db/user-queries.js';
import crypto from 'node:crypto';

describe('user CRUD', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
  });

  it('should create a user and retrieve by id', () => {
    const id = crypto.randomUUID();
    createUser(db, { id, name: 'Robert', email: 'rob@dearborndenim.com', role: 'admin' });
    const user = getUserById(db, id);
    expect(user).toBeDefined();
    expect(user!.name).toBe('Robert');
    expect(user!.role).toBe('admin');
    expect(user!.timezone).toBe('America/Chicago');
    expect(user!.briefing_enabled).toBe(1);
  });

  it('should retrieve user by telegram_chat_id', () => {
    const id = crypto.randomUUID();
    createUser(db, { id, name: 'Robert', email: 'rob@dd.com', role: 'admin', telegram_chat_id: '12345' });
    const user = getUserByTelegramChatId(db, '12345');
    expect(user).toBeDefined();
    expect(user!.id).toBe(id);
  });

  it('should return undefined for unknown chat_id', () => {
    const user = getUserByTelegramChatId(db, '99999');
    expect(user).toBeUndefined();
  });

  it('should list active users with briefing_enabled', () => {
    createUser(db, { id: 'u1', name: 'A', email: 'a@x.com', role: 'member' });
    createUser(db, { id: 'u2', name: 'B', email: 'b@x.com', role: 'member' });
    db.prepare('UPDATE users SET briefing_enabled = 0 WHERE id = ?').run('u2');
    const active = getActiveUsers(db);
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe('u1');
  });

  it('should add and retrieve email accounts for a user', () => {
    createUser(db, { id: 'u1', name: 'A', email: 'a@x.com', role: 'member' });
    addEmailAccount(db, { id: 'ea1', user_id: 'u1', email_address: 'a@x.com', provider: 'outlook' });
    addEmailAccount(db, { id: 'ea2', user_id: 'u1', email_address: 'a2@x.com', provider: 'outlook' });
    const accounts = getUserEmailAccounts(db, 'u1');
    expect(accounts).toHaveLength(2);
  });

  it('should set and get user preferences', () => {
    createUser(db, { id: 'u1', name: 'A', email: 'a@x.com', role: 'member' });
    setUserPreferences(db, 'u1', { business_context: 'Manages operations at DD' });
    const prefs = getUserPreferences(db, 'u1');
    expect(prefs).toBeDefined();
    expect(prefs!.business_context).toBe('Manages operations at DD');
  });

  it('should create and consume an invite', () => {
    createUser(db, { id: 'u1', name: 'A', email: 'a@x.com', role: 'member' });
    const code = createInvite(db, 'u1');
    expect(code).toBeTruthy();

    const userId = consumeInvite(db, code);
    expect(userId).toBe('u1');

    // Second use should fail
    const again = consumeInvite(db, code);
    expect(again).toBeUndefined();
  });

  it('should reject expired invite', () => {
    createUser(db, { id: 'u1', name: 'A', email: 'a@x.com', role: 'member' });
    const code = 'expired-code';
    db.prepare(
      "INSERT INTO user_invites (code, user_id, expires_at) VALUES (?, ?, datetime('now', '-1 hour'))"
    ).run(code, 'u1');
    const userId = consumeInvite(db, code);
    expect(userId).toBeUndefined();
  });

  it('should link telegram chat to user via invite', () => {
    createUser(db, { id: 'u1', name: 'A', email: 'a@x.com', role: 'member' });
    const code = createInvite(db, 'u1');
    linkTelegramChat(db, 'u1', '67890');
    const user = getUserByTelegramChatId(db, '67890');
    expect(user).toBeDefined();
    expect(user!.id).toBe('u1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/robertmcmillan/Documents/claude/claude_code/McSecretary && npx vitest run tests/db/user-queries.test.ts`
Expected: FAIL — imports don't exist yet

- [ ] **Step 3: Implement user queries**

```typescript
// src/db/user-queries.ts
import type Database from 'better-sqlite3';
import crypto from 'node:crypto';

export interface User {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'member';
  telegram_chat_id: string | null;
  timezone: string;
  briefing_enabled: number;
  briefing_cron: string;
  created_at: string;
  updated_at: string;
}

export interface UserEmailAccount {
  id: string;
  user_id: string;
  email_address: string;
  provider: string;
  enabled: number;
  created_at: string;
}

export interface UserPreferences {
  user_id: string;
  classifier_system_prompt: string | null;
  briefing_system_prompt: string | null;
  business_context: string | null;
  vip_senders: string;
  quiet_categories: string;
  updated_at: string;
}

export interface CreateUserInput {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'member';
  telegram_chat_id?: string;
  timezone?: string;
  briefing_cron?: string;
}

export function createUser(db: Database.Database, input: CreateUserInput): void {
  db.prepare(`
    INSERT INTO users (id, name, email, role, telegram_chat_id, timezone, briefing_cron)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.name,
    input.email,
    input.role,
    input.telegram_chat_id ?? null,
    input.timezone ?? 'America/Chicago',
    input.briefing_cron ?? '0 4 * * 1-5',
  );
}

export function getUserById(db: Database.Database, id: string): User | undefined {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as User | undefined;
}

export function getUserByTelegramChatId(db: Database.Database, chatId: string): User | undefined {
  return db.prepare('SELECT * FROM users WHERE telegram_chat_id = ?').get(chatId) as User | undefined;
}

export function getActiveUsers(db: Database.Database): User[] {
  return db.prepare('SELECT * FROM users WHERE briefing_enabled = 1').all() as User[];
}

export function getAllUsers(db: Database.Database): User[] {
  return db.prepare('SELECT * FROM users').all() as User[];
}

export function addEmailAccount(
  db: Database.Database,
  input: { id: string; user_id: string; email_address: string; provider: string },
): void {
  db.prepare(`
    INSERT INTO user_email_accounts (id, user_id, email_address, provider)
    VALUES (?, ?, ?, ?)
  `).run(input.id, input.user_id, input.email_address, input.provider);
}

export function getUserEmailAccounts(db: Database.Database, userId: string): UserEmailAccount[] {
  return db.prepare(
    'SELECT * FROM user_email_accounts WHERE user_id = ? AND enabled = 1'
  ).all(userId) as UserEmailAccount[];
}

export function getUserPreferences(db: Database.Database, userId: string): UserPreferences | undefined {
  return db.prepare('SELECT * FROM user_preferences WHERE user_id = ?').get(userId) as UserPreferences | undefined;
}

export function setUserPreferences(
  db: Database.Database,
  userId: string,
  prefs: Partial<Omit<UserPreferences, 'user_id' | 'updated_at'>>,
): void {
  const existing = getUserPreferences(db, userId);
  if (!existing) {
    db.prepare(`
      INSERT INTO user_preferences (user_id, business_context, classifier_system_prompt, briefing_system_prompt, vip_senders, quiet_categories)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      userId,
      prefs.business_context ?? null,
      prefs.classifier_system_prompt ?? null,
      prefs.briefing_system_prompt ?? null,
      prefs.vip_senders ?? '[]',
      prefs.quiet_categories ?? '["junk","promotional","newsletter"]',
    );
  } else {
    const fields: string[] = [];
    const values: (string | null)[] = [];
    for (const [key, val] of Object.entries(prefs)) {
      fields.push(`${key} = ?`);
      values.push(val as string | null);
    }
    fields.push("updated_at = datetime('now')");
    values.push(userId);
    db.prepare(`UPDATE user_preferences SET ${fields.join(', ')} WHERE user_id = ?`).run(...values);
  }
}

export function createInvite(db: Database.Database, userId: string): string {
  const code = crypto.randomUUID().slice(0, 8);
  db.prepare(`
    INSERT INTO user_invites (code, user_id, expires_at)
    VALUES (?, ?, datetime('now', '+24 hours'))
  `).run(code, userId);
  return code;
}

export function consumeInvite(db: Database.Database, code: string): string | undefined {
  const invite = db.prepare(`
    SELECT user_id FROM user_invites
    WHERE code = ? AND used_at IS NULL AND expires_at > datetime('now')
  `).get(code) as { user_id: string } | undefined;

  if (!invite) return undefined;

  db.prepare("UPDATE user_invites SET used_at = datetime('now') WHERE code = ?").run(code);
  return invite.user_id;
}

export function linkTelegramChat(db: Database.Database, userId: string, chatId: string): void {
  db.prepare('UPDATE users SET telegram_chat_id = ? WHERE id = ?').run(chatId, userId);
}

export function getAdminUsers(db: Database.Database): User[] {
  return db.prepare("SELECT * FROM users WHERE role = 'admin'").all() as User[];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/robertmcmillan/Documents/claude/claude_code/McSecretary && npx vitest run tests/db/user-queries.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/db/user-queries.ts tests/db/user-queries.test.ts
git commit -m "feat: add user CRUD queries — create, lookup, email accounts, preferences, invites"
```

---

## Task 3: Dev Request Queries

**Files:**
- Create: `src/db/request-queries.ts`
- Test: `tests/db/request-queries.test.ts`

- [ ] **Step 1: Write failing tests for dev request CRUD**

```typescript
// tests/db/request-queries.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import { createUser } from '../../src/db/user-queries.js';
import {
  insertDevRequest,
  getPendingDevRequests,
  getDevRequestsByUser,
  approveDevRequest,
  rejectDevRequest,
  getDevRequestById,
} from '../../src/db/request-queries.js';

describe('dev request queries', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
    createUser(db, { id: 'robert', name: 'Robert', email: 'rob@dd.com', role: 'admin' });
    createUser(db, { id: 'olivier', name: 'Olivier', email: 'olivier@dd.com', role: 'member' });
  });

  it('should insert a dev request', () => {
    const id = insertDevRequest(db, {
      user_id: 'olivier',
      project: 'kanban-purchaser',
      description: 'Add a vendor report page',
    });
    expect(id).toBeGreaterThan(0);
  });

  it('should list pending dev requests', () => {
    insertDevRequest(db, { user_id: 'olivier', project: 'kanban-purchaser', description: 'Add vendor report' });
    insertDevRequest(db, { user_id: 'olivier', project: 'piece-work-scanner', description: 'Fix badge display' });
    const pending = getPendingDevRequests(db);
    expect(pending).toHaveLength(2);
  });

  it('should list dev requests by user', () => {
    insertDevRequest(db, { user_id: 'olivier', description: 'Request A' });
    insertDevRequest(db, { user_id: 'robert', description: 'Request B' });
    const olivierReqs = getDevRequestsByUser(db, 'olivier');
    expect(olivierReqs).toHaveLength(1);
    expect(olivierReqs[0]!.description).toBe('Request A');
  });

  it('should approve a dev request with refined description', () => {
    const id = insertDevRequest(db, { user_id: 'olivier', description: 'Make the thing faster' });
    approveDevRequest(db, id, 'robert', 'Optimize kanban-purchaser order batching query — add index on vendor_id + status');
    const req = getDevRequestById(db, id);
    expect(req!.status).toBe('approved');
    expect(req!.refined_description).toContain('Optimize');
    expect(req!.reviewed_by).toBe('robert');
  });

  it('should approve without refinement', () => {
    const id = insertDevRequest(db, { user_id: 'olivier', description: 'Fix the 404 on /orders' });
    approveDevRequest(db, id, 'robert');
    const req = getDevRequestById(db, id);
    expect(req!.status).toBe('approved');
    expect(req!.refined_description).toBeNull();
  });

  it('should reject a dev request', () => {
    const id = insertDevRequest(db, { user_id: 'olivier', description: 'Add AI to everything' });
    rejectDevRequest(db, id, 'robert', 'Too vague — what specifically?');
    const req = getDevRequestById(db, id);
    expect(req!.status).toBe('rejected');
    expect(req!.rejection_reason).toBe('Too vague — what specifically?');
  });

  it('should not list approved/rejected in pending', () => {
    const id1 = insertDevRequest(db, { user_id: 'olivier', description: 'A' });
    const id2 = insertDevRequest(db, { user_id: 'olivier', description: 'B' });
    insertDevRequest(db, { user_id: 'olivier', description: 'C' });
    approveDevRequest(db, id1, 'robert');
    rejectDevRequest(db, id2, 'robert', 'no');
    const pending = getPendingDevRequests(db);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.description).toBe('C');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/robertmcmillan/Documents/claude/claude_code/McSecretary && npx vitest run tests/db/request-queries.test.ts`
Expected: FAIL — imports don't exist

- [ ] **Step 3: Implement dev request queries**

```typescript
// src/db/request-queries.ts
import type Database from 'better-sqlite3';

export interface DevRequest {
  id: number;
  user_id: string;
  project: string | null;
  description: string;
  status: string;
  refined_description: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  rejection_reason: string | null;
  created_at: string;
}

export function insertDevRequest(
  db: Database.Database,
  input: { user_id: string; project?: string; description: string },
): number {
  const result = db.prepare(`
    INSERT INTO dev_requests (user_id, project, description)
    VALUES (?, ?, ?)
  `).run(input.user_id, input.project ?? null, input.description);
  return Number(result.lastInsertRowid);
}

export function getDevRequestById(db: Database.Database, id: number): DevRequest | undefined {
  return db.prepare('SELECT * FROM dev_requests WHERE id = ?').get(id) as DevRequest | undefined;
}

export function getPendingDevRequests(db: Database.Database): DevRequest[] {
  return db.prepare(
    "SELECT * FROM dev_requests WHERE status = 'pending' ORDER BY created_at ASC"
  ).all() as DevRequest[];
}

export function getDevRequestsByUser(db: Database.Database, userId: string): DevRequest[] {
  return db.prepare(
    'SELECT * FROM dev_requests WHERE user_id = ? ORDER BY created_at DESC'
  ).all(userId) as DevRequest[];
}

export function approveDevRequest(
  db: Database.Database,
  id: number,
  reviewedBy: string,
  refinedDescription?: string,
): void {
  db.prepare(`
    UPDATE dev_requests
    SET status = 'approved',
        reviewed_by = ?,
        reviewed_at = datetime('now'),
        refined_description = ?
    WHERE id = ?
  `).run(reviewedBy, refinedDescription ?? null, id);
}

export function rejectDevRequest(
  db: Database.Database,
  id: number,
  reviewedBy: string,
  reason: string,
): void {
  db.prepare(`
    UPDATE dev_requests
    SET status = 'rejected',
        reviewed_by = ?,
        reviewed_at = datetime('now'),
        rejection_reason = ?
    WHERE id = ?
  `).run(reviewedBy, reason, id);
}

export function getApprovedDevRequests(db: Database.Database): DevRequest[] {
  return db.prepare(
    "SELECT * FROM dev_requests WHERE status = 'approved' ORDER BY reviewed_at ASC"
  ).all() as DevRequest[];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/robertmcmillan/Documents/claude/claude_code/McSecretary && npx vitest run tests/db/request-queries.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/db/request-queries.ts tests/db/request-queries.test.ts
git commit -m "feat: add dev request queries — insert, approve, reject, list pending"
```

---

## Task 4: Seed Robert's User Record + Backfill

**Files:**
- Create: `src/db/seed-robert.ts`
- Test: `tests/db/seed-robert.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/db/seed-robert.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import { seedRobert } from '../../src/db/seed-robert.js';
import { getUserById, getUserEmailAccounts, getUserPreferences } from '../../src/db/user-queries.js';

describe('seed Robert', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
  });

  it('should create Robert as admin', () => {
    seedRobert(db, '12345');
    const user = getUserById(db, 'robert-mcmillan');
    expect(user).toBeDefined();
    expect(user!.role).toBe('admin');
    expect(user!.telegram_chat_id).toBe('12345');
  });

  it('should create two email accounts for Robert', () => {
    seedRobert(db, '12345');
    const accounts = getUserEmailAccounts(db, 'robert-mcmillan');
    expect(accounts).toHaveLength(2);
    const emails = accounts.map((a) => a.email_address).sort();
    expect(emails).toEqual(['rob@dearborndenim.com', 'robert@mcmillan-manufacturing.com']);
  });

  it('should set Robert business context', () => {
    seedRobert(db, '12345');
    const prefs = getUserPreferences(db, 'robert-mcmillan');
    expect(prefs).toBeDefined();
    expect(prefs!.business_context).toContain('Dearborn Denim');
    expect(prefs!.business_context).toContain('McMillan Manufacturing');
  });

  it('should backfill user_id on existing data', () => {
    // Insert some data without user_id
    db.prepare("INSERT INTO processed_emails (id, account, sender) VALUES ('e1', 'rob@dd.com', 'test@x.com')").run();
    db.prepare("INSERT INTO conversation_log (date, role, message) VALUES ('2026-04-16', 'rob', 'hello')").run();

    seedRobert(db, '12345');

    const email = db.prepare('SELECT user_id FROM processed_emails WHERE id = ?').get('e1') as { user_id: string };
    expect(email.user_id).toBe('robert-mcmillan');

    const conv = db.prepare('SELECT user_id FROM conversation_log WHERE id = 1').get() as { user_id: string };
    expect(conv.user_id).toBe('robert-mcmillan');
  });

  it('should be idempotent', () => {
    seedRobert(db, '12345');
    seedRobert(db, '12345'); // no error
    const accounts = getUserEmailAccounts(db, 'robert-mcmillan');
    expect(accounts).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/robertmcmillan/Documents/claude/claude_code/McSecretary && npx vitest run tests/db/seed-robert.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement seed**

```typescript
// src/db/seed-robert.ts
import type Database from 'better-sqlite3';
import { getUserById, createUser, addEmailAccount, setUserPreferences } from './user-queries.js';

const ROBERT_ID = 'robert-mcmillan';

export function seedRobert(db: Database.Database, telegramChatId: string): void {
  const existing = getUserById(db, ROBERT_ID);
  if (!existing) {
    createUser(db, {
      id: ROBERT_ID,
      name: 'Robert McMillan',
      email: 'rob@dearborndenim.com',
      role: 'admin',
      telegram_chat_id: telegramChatId,
    });

    addEmailAccount(db, {
      id: 'robert-dd',
      user_id: ROBERT_ID,
      email_address: 'rob@dearborndenim.com',
      provider: 'outlook',
    });

    addEmailAccount(db, {
      id: 'robert-mm',
      user_id: ROBERT_ID,
      email_address: 'robert@mcmillan-manufacturing.com',
      provider: 'outlook',
    });

    setUserPreferences(db, ROBERT_ID, {
      business_context: 'Robert McMillan owns Dearborn Denim (rob@dearborndenim.com) — a denim/jeans company with retail + wholesale, and McMillan Manufacturing (robert@mcmillan-manufacturing.com) — contract manufacturing. He also runs an AI agent empire that automates business operations.',
    });
  }

  // Backfill user_id on existing rows that have no user_id
  const tables = [
    'processed_emails',
    'sender_profiles',
    'agent_runs',
    'audit_log',
    'calendar_events',
    'weekly_schedule',
    'pending_actions',
    'time_log',
    'conversation_log',
  ];

  for (const table of tables) {
    db.prepare(`UPDATE ${table} SET user_id = ? WHERE user_id IS NULL`).run(ROBERT_ID);
  }
}

export { ROBERT_ID };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/robertmcmillan/Documents/claude/claude_code/McSecretary && npx vitest run tests/db/seed-robert.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/db/seed-robert.ts tests/db/seed-robert.test.ts
git commit -m "feat: add Robert seed + user_id backfill for existing data"
```

---

## Task 5: Update Existing DB Queries to Accept user_id

**Files:**
- Modify: `src/db/queries.ts`
- Modify: `src/db/calendar-queries.ts`
- Modify: `src/db/conversation-queries.ts`
- Modify: `src/db/time-queries.ts`
- Modify: All corresponding test files

This is the largest task. Every query function gets a `userId` parameter added. All INSERT statements include `user_id`. All SELECT/WHERE clauses filter by `user_id`.

- [ ] **Step 1: Update tests for queries.ts**

Update `tests/db/queries.test.ts` — add `userId` parameter to every call. For example:

```typescript
// Every insertProcessedEmail call gets userId as first new param:
insertProcessedEmail(db, { ...email, user_id: 'robert' });

// Every getOrCreateSenderProfile call:
getOrCreateSenderProfile(db, 'robert', 'test@example.com', 'Test');

// insertAgentRun:
insertAgentRun(db, 'robert', 'overnight');

// getLastRunTimestamp:
getLastRunTimestamp(db, 'robert', 'overnight');

// insertAuditLog:
insertAuditLog(db, { ...entry, user_id: 'robert' });
```

Each test's `beforeEach` must seed a user:
```typescript
beforeEach(() => {
  db = new Database(':memory:');
  initializeSchema(db);
  // Seed a user for FK constraint
  db.prepare("INSERT INTO users (id, name, email, role) VALUES ('robert', 'Robert', 'rob@dd.com', 'admin')").run();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/robertmcmillan/Documents/claude/claude_code/McSecretary && npx vitest run tests/db/queries.test.ts`
Expected: FAIL — function signatures don't match yet

- [ ] **Step 3: Update `src/db/queries.ts`**

```typescript
// src/db/queries.ts
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
  user_id: string;
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
  user_id: string;
}

export function insertProcessedEmail(db: Database.Database, email: ProcessedEmail): void {
  db.prepare(`
    INSERT OR REPLACE INTO processed_emails
    (id, account, sender, sender_name, subject, received_at, category, urgency, action_needed, action_taken, confidence, summary, thread_id, project_id, user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    email.id, email.account, email.sender, email.sender_name, email.subject,
    email.received_at, email.category, email.urgency, email.action_needed,
    email.action_taken, email.confidence, email.summary, email.thread_id,
    email.project_id ?? null, email.user_id
  );
}

export function getOrCreateSenderProfile(
  db: Database.Database, userId: string, email: string, name: string | null
): SenderProfile {
  const existing = db.prepare(
    'SELECT * FROM sender_profiles WHERE email = ? AND user_id = ?'
  ).get(email, userId) as SenderProfile | undefined;
  if (existing) return existing;

  db.prepare(
    'INSERT INTO sender_profiles (email, name, user_id) VALUES (?, ?, ?)'
  ).run(email, name, userId);
  return db.prepare(
    'SELECT * FROM sender_profiles WHERE email = ? AND user_id = ?'
  ).get(email, userId) as SenderProfile;
}

export function updateSenderProfile(
  db: Database.Database, userId: string, email: string, category: string, urgency: string
): void {
  db.prepare(`
    UPDATE sender_profiles
    SET total_emails = total_emails + 1,
        last_seen = datetime('now'),
        default_category = ?,
        default_urgency = ?
    WHERE email = ? AND user_id = ?
  `).run(category, urgency, email, userId);
}

export function insertAgentRun(db: Database.Database, userId: string, runType: string): number {
  const result = db.prepare(`
    INSERT INTO agent_runs (started_at, run_type, user_id)
    VALUES (datetime('now'), ?, ?)
  `).run(runType, userId);
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
    user_id: string;
  },
): void {
  db.prepare(`
    INSERT INTO audit_log (action_type, target_id, target_type, details, confidence, approved_by, user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(entry.action_type, entry.target_id, entry.target_type, entry.details, entry.confidence, entry.approved_by ?? null, entry.user_id);
}

export function getLastRunTimestamp(db: Database.Database, userId: string, runType: string): string | null {
  const row = db.prepare(`
    SELECT completed_at FROM agent_runs
    WHERE run_type = ? AND user_id = ? AND completed_at IS NOT NULL
    ORDER BY completed_at DESC
    LIMIT 1
  `).get(runType, userId) as { completed_at: string } | undefined;
  return row?.completed_at ?? null;
}
```

- [ ] **Step 4: Update `src/db/calendar-queries.ts` — add userId to all functions**

Every function gains a `userId` parameter. INSERT statements include `user_id`. SELECT/WHERE clauses filter by `user_id`. Update the corresponding tests in `tests/db/calendar-queries.test.ts` to pass userId and seed a user in `beforeEach`.

Key signature changes:
- `upsertCalendarEvent(db, event)` → event object gains `user_id: string` field
- `getEventsForDateRange(db, userId, startUtc, endUtc)`
- `upsertWeeklyScheduleDay(db, userId, day)`
- `getWeeklySchedule(db, userId, weekStart)`
- `insertPendingAction(db, userId, action)`
- `getPendingActions(db, userId)`
- `expirePendingActions(db, userId, now)`

- [ ] **Step 5: Update `src/db/conversation-queries.ts` — add userId to all functions**

Signature changes:
- `insertConversationMessage(db, userId, date, role, message)`
- `getTodayConversation(db, userId, date, limit)`
- `getConversationCount(db, userId, date)`
- `getRecentConversation(db, userId, date, limit)`

Update corresponding tests.

- [ ] **Step 6: Update `src/db/time-queries.ts` — add userId to all functions**

Signature changes:
- `insertTimeLog(db, userId, entry)`
- `getTimeLogsForDate(db, userId, date)`
- `getTodayTrackedHours(db, userId, date)`

Update corresponding tests.

- [ ] **Step 7: Run full test suite**

Run: `cd /Users/robertmcmillan/Documents/claude/claude_code/McSecretary && npx vitest run`
Expected: All query tests pass. Some other tests (triage, index) may fail because callers haven't been updated yet — that's expected and will be fixed in subsequent tasks.

- [ ] **Step 8: Commit**

```bash
git add src/db/queries.ts src/db/calendar-queries.ts src/db/conversation-queries.ts src/db/time-queries.ts
git add tests/db/queries.test.ts tests/db/calendar-queries.test.ts tests/db/conversation-queries.test.ts tests/db/time-queries.test.ts
git commit -m "feat: add user_id to all DB query functions — per-user data isolation"
```

---

## Task 6: Update Config to Support Multi-User

**Files:**
- Modify: `src/config.ts`
- Test: No new test file needed — config is validated at startup

- [ ] **Step 1: Make hardcoded email/chatId optional**

```typescript
// src/config.ts
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
} as const;

if (!config.api.secret) {
  console.warn('WARNING: API_SECRET is not set — all API requests will be rejected until configured');
}
```

- [ ] **Step 2: Run full test suite**

Run: `cd /Users/robertmcmillan/Documents/claude/claude_code/McSecretary && npx vitest run`
Expected: No regressions from config change (emails were already optional strings)

- [ ] **Step 3: Commit**

```bash
git add src/config.ts
git commit -m "refactor: make outlook emails and telegram chatId optional — multi-user reads from DB"
```

---

## Task 7: Update Telegram Bot for Multi-User Routing

**Files:**
- Modify: `src/telegram/bot.ts`
- Test: `tests/multi-user/routing.test.ts`

- [ ] **Step 1: Write failing tests for per-user message sending**

```typescript
// tests/multi-user/routing.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import { createUser } from '../../src/db/user-queries.js';

describe('multi-user telegram routing', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
    createUser(db, { id: 'robert', name: 'Robert', email: 'rob@dd.com', role: 'admin', telegram_chat_id: '111' });
    createUser(db, { id: 'olivier', name: 'Olivier', email: 'olivier@dd.com', role: 'member', telegram_chat_id: '222' });
    createUser(db, { id: 'merab', name: 'Merab', email: 'merab@dd.com', role: 'member', telegram_chat_id: '333' });
  });

  it('should find user by chat_id', () => {
    const { getUserByTelegramChatId } = require('../../src/db/user-queries.js');
    const user = getUserByTelegramChatId(db, '222');
    expect(user).toBeDefined();
    expect(user!.name).toBe('Olivier');
  });

  it('should return undefined for unknown chat_id', () => {
    const { getUserByTelegramChatId } = require('../../src/db/user-queries.js');
    const user = getUserByTelegramChatId(db, '999');
    expect(user).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it passes** (these use already-built user-queries)

Run: `cd /Users/robertmcmillan/Documents/claude/claude_code/McSecretary && npx vitest run tests/multi-user/routing.test.ts`

- [ ] **Step 3: Update `src/telegram/bot.ts` for per-user sending**

```typescript
// src/telegram/bot.ts
import { Bot } from 'grammy';
import type Database from 'better-sqlite3';

let bot: Bot | null = null;
let botDb: Database.Database | null = null;

export function setBotDb(db: Database.Database): void {
  botDb = db;
}

export async function initBot(): Promise<Bot> {
  if (bot) return bot;
  const { config } = await import('../config.js');
  bot = new Bot(config.telegram.botToken);
  return bot;
}

export function getBot(): Bot {
  if (!bot) throw new Error('Bot not initialized. Call initBot() first.');
  return bot;
}

function getChatIdForUser(userId: string): string {
  if (!botDb) throw new Error('Bot DB not set. Call setBotDb() first.');
  const { getUserById } = require('../db/user-queries.js');
  const user = getUserById(botDb, userId);
  if (!user?.telegram_chat_id) throw new Error(`No Telegram chat linked for user ${userId}`);
  return user.telegram_chat_id;
}

export async function sendMessageToUser(userId: string, text: string, markdown: boolean = true): Promise<void> {
  const b = getBot();
  const chatId = getChatIdForUser(userId);

  if (!text || text.trim().length === 0) {
    console.warn('sendMessageToUser called with empty text, skipping');
    return;
  }

  const parseMode = markdown ? 'Markdown' : undefined;

  if (text.length <= 4096) {
    await b.api.sendMessage(chatId, text, { parse_mode: parseMode });
  } else {
    const chunks = splitMessage(text, 4096);
    for (const chunk of chunks) {
      await b.api.sendMessage(chatId, chunk, { parse_mode: parseMode });
    }
  }
}

// Keep legacy sendMessage for backward compat during transition — sends to a specific chatId
export async function sendMessage(text: string, markdown: boolean = true): Promise<void> {
  const b = getBot();
  const { config } = await import('../config.js');

  if (!text || text.trim().length === 0) {
    console.warn('sendMessage called with empty text, skipping');
    return;
  }

  // If botDb is set, try to find Robert's chat_id from DB; fall back to env var
  let chatId = config.telegram.chatId;
  if (botDb) {
    try {
      chatId = getChatIdForUser('robert-mcmillan');
    } catch {
      // fall back to env var
    }
  }

  if (!chatId) {
    console.warn('No chat_id available — message not sent');
    return;
  }

  const parseMode = markdown ? 'Markdown' : undefined;

  if (text.length <= 4096) {
    await b.api.sendMessage(chatId, text, { parse_mode: parseMode });
  } else {
    const chunks = splitMessage(text, 4096);
    for (const chunk of chunks) {
      await b.api.sendMessage(chatId, chunk, { parse_mode: parseMode });
    }
  }
}

function splitMessage(text: string, maxLength: number): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    let splitAt = remaining.lastIndexOf('\n', maxLength);
    if (splitAt <= 0) {
      splitAt = maxLength;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt + 1);
  }

  return chunks;
}

export function formatBriefingForTelegram(briefing: string): string {
  return briefing
    .replace(/^### (.+)$/gm, '*$1*')
    .replace(/^## (.+)$/gm, '*$1*')
    .replace(/^# (.+)$/gm, '*$1*');
}

export async function sendBriefingToUser(userId: string, briefing: string): Promise<void> {
  const formatted = formatBriefingForTelegram(briefing);
  await sendMessageToUser(userId, formatted);
}

// Legacy — sends to Robert
export async function sendBriefing(briefing: string): Promise<void> {
  const formatted = formatBriefingForTelegram(briefing);
  await sendMessage(formatted);
}

export async function sendCheckInToUser(userId: string): Promise<void> {
  const now = new Date();
  const hour = now.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/Chicago',
  });
  await sendMessageToUser(userId, `Quick check (${hour}) — what did you work on this past hour?`);
}

export async function sendCheckIn(): Promise<void> {
  const now = new Date();
  const hour = now.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/Chicago',
  });
  await sendMessage(`Quick check (${hour}) — what did you work on this past hour?`);
}

export async function sendEveningSummary(summary: string): Promise<void> {
  await sendMessage(`*End of Day Summary*\n\n${summary}`);
}

export async function sendEveningSummaryToUser(userId: string, summary: string): Promise<void> {
  await sendMessageToUser(userId, `*End of Day Summary*\n\n${summary}`);
}
```

- [ ] **Step 4: Run full test suite**

Run: `cd /Users/robertmcmillan/Documents/claude/claude_code/McSecretary && npx vitest run`

- [ ] **Step 5: Commit**

```bash
git add src/telegram/bot.ts tests/multi-user/routing.test.ts
git commit -m "feat: add per-user Telegram message sending — sendMessageToUser, sendBriefingToUser"
```

---

## Task 8: Update Triage Pipeline for Per-User Execution

**Files:**
- Modify: `src/triage.ts`
- Modify: `src/briefing/generator.ts`
- Test: `tests/multi-user/triage.test.ts`

- [ ] **Step 1: Write failing test for per-user triage**

```typescript
// tests/multi-user/triage.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import { createUser, addEmailAccount, setUserPreferences } from '../../src/db/user-queries.js';
import { buildBriefingPrompt } from '../../src/briefing/generator.js';

describe('per-user briefing', () => {
  it('should include user business_context in briefing prompt when preferences provided', () => {
    const prompt = buildBriefingPrompt(
      [], // no emails
      { totalProcessed: 0, archived: 0, flaggedForReview: 0 },
      undefined, // no calendar
      undefined, // no dev summary
      undefined, // no production
      { business_context: 'Olivier manages operations at Dearborn Denim', name: 'Olivier' },
    );
    expect(prompt).toContain('Olivier');
  });

  it('should use default briefing prompt when no preferences provided', () => {
    const prompt = buildBriefingPrompt(
      [],
      { totalProcessed: 0, archived: 0, flaggedForReview: 0 },
    );
    // Default prompt doesn't mention specific user
    expect(prompt).toContain('Total emails processed');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/robertmcmillan/Documents/claude/claude_code/McSecretary && npx vitest run tests/multi-user/triage.test.ts`
Expected: FAIL — `buildBriefingPrompt` doesn't accept user context param yet

- [ ] **Step 3: Update `src/briefing/generator.ts` for per-user system prompt**

Add a `userContext` optional parameter to `buildBriefingPrompt` and `generateBriefing`:

```typescript
// src/briefing/generator.ts
import Anthropic from '@anthropic-ai/sdk';
import type { ClassifiedEmail } from '../email/types.js';
import type { CalendarBriefingData } from '../calendar/types.js';

export interface UserBriefingContext {
  name: string;
  business_context: string | null;
}

function getBriefingSystemPrompt(userContext?: UserBriefingContext): string {
  const userName = userContext?.name ?? 'Rob McMillan';
  const businessCtx = userContext?.business_context
    ?? "Rob owns Dearborn Denim (rob@dearborndenim.com) and McMillan Manufacturing (robert@mcmillan-manufacturing.com). Email is Outlook-only (2 accounts).";

  return `You are McSecretary, an AI secretary generating ${userName}'s morning briefing.

${businessCtx}

Generate a concise, actionable morning briefing in markdown format. Structure:

1. **Overnight Dev** — Summary of what the AI agent empire built overnight. Only include if overnight build data is provided.
2. **Factory Production** — Yesterday's production numbers, trends vs last week, and any notable streaks. Only include if production data is provided.
3. **Today's Schedule** — Calendar events for today with times (Chicago time), conflicts flagged with suggestions, and free time blocks. Only include if calendar data is provided.
4. **Needs Your Attention** — Critical/high urgency email items requiring a response. Include sender, one-line summary, and suggested action.
5. **For Your Review** — Medium priority items to look at when time allows.
6. **FYI / Handled** — What was auto-archived or marked as informational.
7. **Stats** — How many emails processed, archived, flagged.

Keep it conversational but direct. ${userName} is busy — lead with what matters.
Don't use emoji. Use Central Time (Chicago) for all times.`;
}

export interface BriefingStats {
  totalProcessed: number;
  archived: number;
  flaggedForReview: number;
}

export function buildBriefingPrompt(
  emails: ClassifiedEmail[],
  stats: BriefingStats,
  calendar?: CalendarBriefingData,
  overnightDevSummary?: string,
  productionSummary?: string,
  userContext?: UserBriefingContext,
): string {
  // ... (same implementation as current, no changes to the body)
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

  let calendarSection = '';
  if (calendar) {
    const eventList = calendar.events.length === 0
      ? 'No events scheduled.'
      : calendar.events
          .map((e) => `- [ID:${e.id}] ${e.startTime} to ${e.endTime}: ${e.title} (${e.calendarEmail})${e.location ? ` — ${e.location}` : ''}`)
          .join('\n');

    const conflictList = calendar.conflicts.length === 0
      ? 'None'
      : calendar.conflicts
          .map((c) => `- CONFLICT: "${c.eventA.title}" overlaps with "${c.eventB.title}" by ${c.overlapMinutes} minutes.\n  Suggestion: ${c.suggestion ?? 'Manual resolution needed'}`)
          .join('\n');

    const freeList = calendar.freeSlots.length === 0
      ? 'No free blocks today.'
      : calendar.freeSlots
          .map((s) => `- ${s.start} to ${s.end} (${s.durationMinutes} min)`)
          .join('\n');

    const pendingList = calendar.pendingActions.length === 0
      ? ''
      : '\nPending actions awaiting approval:\n' +
        calendar.pendingActions.map((a) => `- ${a.description}`).join('\n');

    calendarSection = `
TODAY'S SCHEDULE:
${eventList}

CONFLICTS:
${conflictList}

FREE TIME BLOCKS:
${freeList}
${pendingList}
`;
  }

  let overnightSection = '';
  if (overnightDevSummary) {
    overnightSection = `
OVERNIGHT DEV REPORT:
${overnightDevSummary}
`;
  }

  let productionSection = '';
  if (productionSummary) {
    productionSection = `
${productionSummary}
`;
  }

  return `Generate the morning briefing for today.

Stats:
- Total emails processed: ${stats.totalProcessed}
- Auto-archived: ${stats.archived}
- Flagged for review: ${stats.flaggedForReview}
${overnightSection}${productionSection}${calendarSection}
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

export async function generateBriefing(
  emails: ClassifiedEmail[],
  stats: BriefingStats,
  calendar?: CalendarBriefingData,
  overnightDevSummary?: string,
  productionSummary?: string,
  userContext?: UserBriefingContext,
): Promise<string> {
  if (!anthropicClient) {
    const { config } = await import('../config.js');
    anthropicClient = new Anthropic({ apiKey: config.anthropic.apiKey });
  }
  const client = anthropicClient;
  const prompt = buildBriefingPrompt(emails, stats, calendar, overnightDevSummary, productionSummary, userContext);
  const systemPrompt = getBriefingSystemPrompt(userContext);

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2000,
    system: systemPrompt,
    messages: [{ role: 'user', content: prompt }],
  });

  return response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');
}
```

- [ ] **Step 4: Update `src/triage.ts` — accept userId, fetch user's email accounts from DB**

Key changes to `runTriage`:
- New signature: `runTriage(db: Database.Database, userId: string): Promise<string>`
- Fetch email accounts from `getUserEmailAccounts(db, userId)` instead of `config.outlook.email1/email2`
- Pass `userId` to all DB insert functions
- Fetch `getUserPreferences(db, userId)` and pass `userContext` to `generateBriefing`
- Pass `userId` to `getLastRunTimestamp`, `insertAgentRun`, etc.

- [ ] **Step 5: Run tests**

Run: `cd /Users/robertmcmillan/Documents/claude/claude_code/McSecretary && npx vitest run tests/multi-user/triage.test.ts tests/briefing/generator.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/triage.ts src/briefing/generator.ts tests/multi-user/triage.test.ts
git commit -m "feat: per-user triage pipeline — fetch email accounts from DB, dynamic briefing prompt"
```

---

## Task 9: Update index.ts — Multi-User Message Routing + /start + /request

**Files:**
- Modify: `src/index.ts`

This is the integration task. The main entry point changes to:
1. Look up user by `chat_id` on every incoming message
2. Handle `/start <invite_code>` for account linking
3. Handle `/request <description>` for dev request submission
4. Handle `/review` for Robert to see pending requests
5. Handle `/approve <id>` and `/reject <id> <reason>` for Robert
6. Route all existing message handling with `userId` context
7. Morning briefing loops over all active users

- [ ] **Step 1: Update `main()` — seed Robert, set botDb**

In `main()`, after `initializeSchema(db)`:

```typescript
// Seed Robert if not already seeded
import { seedRobert } from './db/seed-robert.js';
seedRobert(db, config.telegram.chatId || '');

// Set DB reference for bot
import { setBotDb } from './telegram/bot.js';
setBotDb(db);
```

- [ ] **Step 2: Update bot message handler for multi-user routing**

Replace the single `bot.on('message:text')` handler:

```typescript
bot.on('message:text', async (ctx) => {
  const chatId = ctx.chat.id.toString();
  const text = ctx.message.text;

  // Handle /start <invite_code> — account linking (no user lookup needed)
  if (text.startsWith('/start ')) {
    const code = text.slice(7).trim();
    if (!code) {
      await ctx.reply('Usage: /start <invite_code>');
      return;
    }
    const userId = consumeInvite(db, code);
    if (!userId) {
      await ctx.reply('Invalid or expired invite code.');
      return;
    }
    linkTelegramChat(db, userId, chatId);
    const user = getUserById(db, userId);
    await ctx.reply(`Welcome, ${user?.name ?? 'friend'}! You're linked. Your briefings will arrive here.`);
    return;
  }

  // Look up user by chat_id
  const user = getUserByTelegramChatId(db, chatId);
  if (!user) {
    await ctx.reply('Not registered. Ask your admin for an invite code, then send: /start <code>');
    return;
  }

  console.log(`Message from ${user.name} (${user.id}): ${text.slice(0, 50)}...`);

  try {
    const response = await handleIncomingMessage(user, text);
    if (!response || response.trim().length === 0) {
      await ctx.reply('No response generated.');
      return;
    }
    await ctx.reply(response);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Error handling message:', msg);
    await ctx.reply(`Error: ${msg}`);
  }
});
```

- [ ] **Step 3: Update `handleIncomingMessage` to accept User**

Change signature from `handleIncomingMessage(text: string)` to `handleIncomingMessage(user: User, text: string)`.

Pass `user.id` to all DB query calls: `insertConversationMessage(db, user.id, ...)`, `insertTimeLog(db, user.id, ...)`, `getTimeLogsForDate(db, user.id, ...)`, `getConversationCount(db, user.id, ...)`, etc.

Add new command handlers:

```typescript
// /request — submit a dev request
if (lowerText.startsWith('/request ')) {
  const description = text.slice(9).trim();
  if (!description) {
    return 'Usage: /request <description of what you need>';
  }
  // Try to extract project name if mentioned
  const projectMatch = description.match(/^(\S+):\s*(.*)/);
  const project = projectMatch ? projectMatch[1] : undefined;
  const desc = projectMatch ? projectMatch[2]! : description;
  const id = insertDevRequest(db, { user_id: user.id, project, description: desc });
  insertConversationMessage(db, user.id, today, 'secretary', `Request #${id} submitted. Robert will review it.`);
  // Notify Robert
  const { sendMessageToUser } = await import('./telegram/bot.js');
  await sendMessageToUser('robert-mcmillan', `New dev request #${id} from ${user.name}: ${desc}`).catch(() => {});
  return `Request #${id} submitted. Robert will review it.`;
}

// /myrequests — see your submitted requests
if (lowerText === '/myrequests') {
  const reqs = getDevRequestsByUser(db, user.id);
  if (reqs.length === 0) return 'No requests submitted yet.';
  const list = reqs.slice(0, 10).map((r) =>
    `#${r.id} [${r.status}] ${r.project ? `(${r.project}) ` : ''}${r.description.slice(0, 60)}`
  ).join('\n');
  return `Your requests:\n${list}`;
}

// Admin-only: /review, /approve, /reject
if (lowerText === '/review' && user.role === 'admin') {
  const pending = getPendingDevRequests(db);
  if (pending.length === 0) return 'No pending dev requests.';
  const list = pending.map((r) => {
    const submitter = getUserById(db, r.user_id);
    return `#${r.id} from ${submitter?.name ?? r.user_id}${r.project ? ` (${r.project})` : ''}: ${r.description}`;
  }).join('\n');
  return `Pending requests:\n${list}\n\nUse /approve <id> [refined description] or /reject <id> <reason>`;
}

if (lowerText.startsWith('/approve ') && user.role === 'admin') {
  const parts = text.slice(9).trim().split(/\s+/);
  const id = parseInt(parts[0]!, 10);
  if (isNaN(id)) return 'Usage: /approve <id> [refined description]';
  const refined = parts.slice(1).join(' ') || undefined;
  approveDevRequest(db, id, user.id, refined);
  const req = getDevRequestById(db, id);
  // Notify the requester
  if (req) {
    await sendMessageToUser(req.user_id, `Your request #${id} was approved!${refined ? ` Refined: ${refined}` : ''}`).catch(() => {});
  }
  return `Request #${id} approved.${refined ? ` Refined: ${refined}` : ''}`;
}

if (lowerText.startsWith('/reject ') && user.role === 'admin') {
  const parts = text.slice(8).trim().split(/\s+/);
  const id = parseInt(parts[0]!, 10);
  if (isNaN(id)) return 'Usage: /reject <id> <reason>';
  const reason = parts.slice(1).join(' ') || 'No reason given';
  rejectDevRequest(db, id, user.id, reason);
  const req = getDevRequestById(db, id);
  if (req) {
    await sendMessageToUser(req.user_id, `Your request #${id} was not approved: ${reason}`).catch(() => {});
  }
  return `Request #${id} rejected: ${reason}`;
}
```

- [ ] **Step 4: Update morning briefing handler to loop over all users**

```typescript
async function handleMorningBriefing(): Promise<void> {
  console.log('Running morning briefings for all users...');

  const users = getActiveUsers(db);

  for (const user of users) {
    try {
      // Generate reflection for admin only (Robert)
      if (user.role === 'admin') {
        const yesterday = getYesterdayDate(TIMEZONE);
        try {
          const result = await generateEndOfDayReflection(db, anthropic, yesterday);
          if (result === 'completed') {
            console.log(`Yesterday's reflection (${yesterday}) complete.`);
          }
        } catch (err) {
          console.error('Reflection generation failed:', (err as Error).message);
        }
      }

      const briefing = await runTriage(db, user.id);
      await sendBriefingToUser(user.id, briefing);
      const today = getChicagoDate();
      insertConversationMessage(db, user.id, today, 'secretary', `[Morning Briefing]\n${briefing}`);
      console.log(`Briefing sent to ${user.name}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Morning briefing failed for ${user.name}: ${msg}`);
      await sendMessageToUser(user.id, `Morning briefing failed: ${msg}`).catch(() => {});
    }
  }
}
```

- [ ] **Step 5: Update system prompt to be user-aware**

The `SYSTEM_PROMPT_BASE` should adapt per user. When building the system prompt for a non-Robert user, omit the admin-only tools (empire tools, schedule management) and adjust the business context.

- [ ] **Step 6: Update hourly check-in and evening summary to loop over users**

```typescript
async function handleHourlyCheckIn(): Promise<void> {
  const users = getActiveUsers(db);
  for (const user of users) {
    await sendCheckInToUser(user.id);
    const today = getChicagoDate();
    insertConversationMessage(db, user.id, today, 'secretary', 'Quick check — what did you work on this past hour?');
  }
}
```

- [ ] **Step 7: Run full test suite**

Run: `cd /Users/robertmcmillan/Documents/claude/claude_code/McSecretary && npx vitest run`
Expected: All tests pass

- [ ] **Step 8: Commit**

```bash
git add src/index.ts
git commit -m "feat: multi-user message routing — /start, /request, /review, per-user briefings"
```

---

## Task 10: Update tools.ts to Pass userId

**Files:**
- Modify: `src/tools.ts`

- [ ] **Step 1: Add userId parameter to tool execution context**

The `executeTool` function needs a `userId` parameter so that all DB operations within tools are user-scoped. The `setToolsDb` function should also accept the current user context.

Key changes:
- `executeTool(name, input, userId)` — new parameter
- All tool handlers that call DB functions pass `userId`
- Email tools use user's email accounts from DB instead of `config.outlook.email1/email2`
- Empire tools (read_project_status, append_project_feedback, list_projects, get_nightly_plan) remain shared — no userId scoping needed
- Admin tools are gated by role check

- [ ] **Step 2: Run full test suite**

Run: `cd /Users/robertmcmillan/Documents/claude/claude_code/McSecretary && npx vitest run`

- [ ] **Step 3: Commit**

```bash
git add src/tools.ts
git commit -m "feat: pass userId through tool execution — user-scoped email, calendar, task operations"
```

---

## Task 11: Admin CLI

**Files:**
- Create: `src/admin.ts`
- Test: `tests/admin.test.ts`

- [ ] **Step 1: Write failing tests for admin CLI**

```typescript
// tests/admin.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../src/db/schema.js';
import { parseAdminCommand, executeAdminCommand } from '../src/admin.js';

describe('admin CLI', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
  });

  it('should parse add-user command', () => {
    const cmd = parseAdminCommand(['add-user', '--name', 'Olivier', '--email', 'olivier@dd.com', '--role', 'member']);
    expect(cmd.action).toBe('add-user');
    expect(cmd.args.name).toBe('Olivier');
    expect(cmd.args.email).toBe('olivier@dd.com');
  });

  it('should create user and generate invite', async () => {
    const result = await executeAdminCommand(db, {
      action: 'add-user',
      args: { name: 'Olivier', email: 'olivier@dd.com', role: 'member' },
    });
    expect(result).toContain('Created user');
    expect(result).toContain('Invite code:');
  });

  it('should add email account', async () => {
    await executeAdminCommand(db, {
      action: 'add-user',
      args: { name: 'Olivier', email: 'olivier@dd.com', role: 'member' },
    });
    // Get the user ID
    const { getAllUsers } = await import('../src/db/user-queries.js');
    const users = getAllUsers(db);
    const olivier = users.find((u) => u.email === 'olivier@dd.com');

    const result = await executeAdminCommand(db, {
      action: 'add-email',
      args: { 'user-id': olivier!.id, email: 'olivier@dd.com', provider: 'outlook' },
    });
    expect(result).toContain('Email account added');
  });

  it('should list users', async () => {
    await executeAdminCommand(db, { action: 'add-user', args: { name: 'Olivier', email: 'o@dd.com', role: 'member' } });
    await executeAdminCommand(db, { action: 'add-user', args: { name: 'Merab', email: 'm@dd.com', role: 'member' } });
    const result = await executeAdminCommand(db, { action: 'list-users', args: {} });
    expect(result).toContain('Olivier');
    expect(result).toContain('Merab');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/robertmcmillan/Documents/claude/claude_code/McSecretary && npx vitest run tests/admin.test.ts`

- [ ] **Step 3: Implement admin CLI**

```typescript
// src/admin.ts
import 'dotenv/config';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import { config } from './config.js';
import { initializeSchema } from './db/schema.js';
import {
  createUser,
  getAllUsers,
  getUserById,
  addEmailAccount,
  setUserPreferences,
  getUserEmailAccounts,
  createInvite,
} from './db/user-queries.js';

export interface AdminCommand {
  action: string;
  args: Record<string, string>;
}

export function parseAdminCommand(argv: string[]): AdminCommand {
  const action = argv[0]!;
  const args: Record<string, string> = {};
  for (let i = 1; i < argv.length; i += 2) {
    const key = argv[i]!.replace(/^--/, '');
    args[key] = argv[i + 1] ?? '';
  }
  return { action, args };
}

export async function executeAdminCommand(db: Database.Database, cmd: AdminCommand): Promise<string> {
  switch (cmd.action) {
    case 'add-user': {
      const id = crypto.randomUUID();
      createUser(db, {
        id,
        name: cmd.args.name!,
        email: cmd.args.email!,
        role: (cmd.args.role as 'admin' | 'member') ?? 'member',
        timezone: cmd.args.timezone,
        briefing_cron: cmd.args['briefing-cron'],
      });
      const code = createInvite(db, id);
      return `Created user: ${cmd.args.name} (${id})\nInvite code: ${code}\nTell them to message the bot with: /start ${code}`;
    }

    case 'add-email': {
      const emailId = crypto.randomUUID();
      addEmailAccount(db, {
        id: emailId,
        user_id: cmd.args['user-id']!,
        email_address: cmd.args.email!,
        provider: cmd.args.provider ?? 'outlook',
      });
      return `Email account added: ${cmd.args.email}`;
    }

    case 'set-preferences': {
      const prefs: Record<string, string> = {};
      if (cmd.args['business-context']) prefs.business_context = cmd.args['business-context'];
      if (cmd.args['briefing-cron']) {
        db.prepare('UPDATE users SET briefing_cron = ? WHERE id = ?').run(cmd.args['briefing-cron'], cmd.args['user-id']);
      }
      if (Object.keys(prefs).length > 0) {
        setUserPreferences(db, cmd.args['user-id']!, prefs);
      }
      return `Preferences updated for ${cmd.args['user-id']}`;
    }

    case 'list-users': {
      const users = getAllUsers(db);
      if (users.length === 0) return 'No users.';
      const lines = users.map((u) => {
        const accounts = getUserEmailAccounts(db, u.id);
        const emails = accounts.map((a) => a.email_address).join(', ');
        return `${u.name} (${u.role}) — ${u.email} | Telegram: ${u.telegram_chat_id ?? 'not linked'} | Accounts: ${emails || 'none'}`;
      });
      return lines.join('\n');
    }

    case 'generate-invite': {
      const code = createInvite(db, cmd.args['user-id']!);
      return `Invite code: ${code}\nExpires in 24 hours.`;
    }

    default:
      return `Unknown command: ${cmd.action}. Available: add-user, add-email, set-preferences, list-users, generate-invite`;
  }
}

// CLI entry point
if (require.main === module) {
  const db = new Database(config.db.path);
  db.pragma('journal_mode = WAL');
  initializeSchema(db);

  const cmd = parseAdminCommand(process.argv.slice(2));
  executeAdminCommand(db, cmd)
    .then((result) => {
      console.log(result);
      db.close();
    })
    .catch((err) => {
      console.error('Admin command failed:', err);
      db.close();
      process.exit(1);
    });
}
```

- [ ] **Step 4: Add npm script**

In `package.json`, add:
```json
"admin": "tsx src/admin.ts"
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /Users/robertmcmillan/Documents/claude/claude_code/McSecretary && npx vitest run tests/admin.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/admin.ts tests/admin.test.ts package.json
git commit -m "feat: add admin CLI — add-user, add-email, set-preferences, list-users, generate-invite"
```

---

## Task 12: Include Pending Dev Requests in Robert's Briefing + Approved Requests in Nightly Plan

**Files:**
- Modify: `src/triage.ts`
- Modify: `src/briefing/generator.ts`
- Modify: `src/empire/tools.ts` (or new file for nightly plan integration)

- [ ] **Step 1: Add pending requests section to Robert's briefing**

In `runTriage`, after fetching overnight dev summary, for admin users:

```typescript
// Fetch pending dev requests for admin briefing
let pendingRequestsSection: string | undefined;
if (user.role === 'admin') {
  const pendingRequests = getPendingDevRequests(db);
  if (pendingRequests.length > 0) {
    pendingRequestsSection = pendingRequests.map((r) => {
      const submitter = getUserById(db, r.user_id);
      return `- #${r.id} from ${submitter?.name ?? 'unknown'}${r.project ? ` (${r.project})` : ''}: ${r.description}`;
    }).join('\n');
  }
}
```

Pass `pendingRequestsSection` to `buildBriefingPrompt` and add it as an optional section in the briefing.

- [ ] **Step 2: Update briefing system prompt**

Add to the structure:
```
8. **Dev Requests** — Pending feature requests from team members. Only include for admin users. Show request ID, who submitted it, and the description.
```

- [ ] **Step 3: Make approved requests available to Foreman**

The Foreman reads `NIGHTLY_PLAN.md` for its task queue. Approved dev requests need to be appended to the nightly plan. Add a function:

```typescript
// src/empire/request-sync.ts
export function formatApprovedRequestsForPlan(db: Database.Database): string {
  const approved = getApprovedDevRequests(db);
  if (approved.length === 0) return '';

  return approved.map((r) => {
    const submitter = getUserById(db, r.user_id);
    const desc = r.refined_description ?? r.description;
    return `### Team Request #${r.id}: ${desc}\n**Submitted by:** ${submitter?.name ?? 'unknown'}\n**Project:** ${r.project ?? 'unspecified'}\n`;
  }).join('\n');
}
```

The Foreman's PLANNER_INSTRUCTIONS.md already reads NIGHTLY_PLAN.md — we add a section "Team Requests" that gets populated from approved dev_requests.

- [ ] **Step 4: Run full test suite**

Run: `cd /Users/robertmcmillan/Documents/claude/claude_code/McSecretary && npx vitest run`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/triage.ts src/briefing/generator.ts src/empire/request-sync.ts
git commit -m "feat: include pending dev requests in Robert's briefing, export approved requests for nightly plan"
```

---

## Task 13: Seed Olivier and Merab

**Files:**
- Create: `src/db/seed-team.ts`
- Test: `tests/db/seed-team.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/db/seed-team.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import { seedRobert } from '../../src/db/seed-robert.js';
import { seedTeam } from '../../src/db/seed-team.js';
import { getAllUsers, getUserEmailAccounts, getUserPreferences } from '../../src/db/user-queries.js';

describe('seed team', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
    seedRobert(db, '12345');
  });

  it('should create Olivier and Merab', () => {
    seedTeam(db);
    const users = getAllUsers(db);
    expect(users).toHaveLength(3); // Robert + Olivier + Merab
    expect(users.map((u) => u.name).sort()).toEqual(['Merab', 'Olivier', 'Robert McMillan']);
  });

  it('should set email accounts for each', () => {
    seedTeam(db);
    const users = getAllUsers(db);
    const olivier = users.find((u) => u.name === 'Olivier')!;
    const merab = users.find((u) => u.name === 'Merab')!;
    expect(getUserEmailAccounts(db, olivier.id)).toHaveLength(1);
    expect(getUserEmailAccounts(db, merab.id)).toHaveLength(1);
    expect(getUserEmailAccounts(db, olivier.id)[0]!.email_address).toBe('olivier@dearborndenim.com');
    expect(getUserEmailAccounts(db, merab.id)[0]!.email_address).toBe('merab@dearborndenim.com');
  });

  it('should set business context', () => {
    seedTeam(db);
    const users = getAllUsers(db);
    const olivier = users.find((u) => u.name === 'Olivier')!;
    const prefs = getUserPreferences(db, olivier.id);
    expect(prefs).toBeDefined();
    expect(prefs!.business_context).toBeTruthy();
  });

  it('should be idempotent', () => {
    seedTeam(db);
    seedTeam(db);
    const users = getAllUsers(db);
    expect(users).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Implement seed**

```typescript
// src/db/seed-team.ts
import type Database from 'better-sqlite3';
import { getUserById, createUser, addEmailAccount, setUserPreferences, createInvite } from './user-queries.js';

export function seedTeam(db: Database.Database): { invites: { name: string; code: string }[] } {
  const invites: { name: string; code: string }[] = [];

  const team = [
    {
      id: 'olivier',
      name: 'Olivier',
      email: 'olivier@dearborndenim.com',
      business_context: 'Olivier works at Dearborn Denim. End user of kanban-purchaser, piece-work-scanner, and other operational tools.',
    },
    {
      id: 'merab',
      name: 'Merab',
      email: 'merab@dearborndenim.com',
      business_context: 'Merab works at Dearborn Denim. End user of kanban-purchaser, piece-work-scanner, and other operational tools.',
    },
  ];

  for (const member of team) {
    const existing = getUserById(db, member.id);
    if (!existing) {
      createUser(db, {
        id: member.id,
        name: member.name,
        email: member.email,
        role: 'member',
      });

      addEmailAccount(db, {
        id: `${member.id}-dd`,
        user_id: member.id,
        email_address: member.email,
        provider: 'outlook',
      });

      setUserPreferences(db, member.id, {
        business_context: member.business_context,
      });

      const code = createInvite(db, member.id);
      invites.push({ name: member.name, code });
    }
  }

  return { invites };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/robertmcmillan/Documents/claude/claude_code/McSecretary && npx vitest run tests/db/seed-team.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Wire seed into main() startup**

In `src/index.ts` `main()`, after `seedRobert`:

```typescript
import { seedTeam } from './db/seed-team.js';
const { invites } = seedTeam(db);
if (invites.length > 0) {
  console.log('New team members seeded. Invite codes:');
  for (const inv of invites) {
    console.log(`  ${inv.name}: /start ${inv.code}`);
  }
}
```

- [ ] **Step 6: Commit**

```bash
git add src/db/seed-team.ts tests/db/seed-team.test.ts src/index.ts
git commit -m "feat: seed Olivier and Merab — email accounts, preferences, invite codes"
```

---

## Task 14: Final Integration Test + Full Suite

**Files:**
- All test files

- [ ] **Step 1: Run full test suite**

Run: `cd /Users/robertmcmillan/Documents/claude/claude_code/McSecretary && npx vitest run`
Expected: ALL PASS

- [ ] **Step 2: Run TypeScript type check**

Run: `cd /Users/robertmcmillan/Documents/claude/claude_code/McSecretary && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Test build**

Run: `cd /Users/robertmcmillan/Documents/claude/claude_code/McSecretary && npm run build 2>&1 || npx tsc --noEmit`
Expected: Clean compile

- [ ] **Step 4: Commit any final fixes**

```bash
git add -A
git commit -m "fix: resolve integration issues from multi-user migration"
```

---

## Task 15: Update PROJECT_STATUS.md and CLAUDE.md

**Files:**
- Modify: `PROJECT_STATUS.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update CLAUDE.md with new commands and architecture**

Add to commands section:
```
- `npx tsx src/admin.ts add-user --name X --email Y --role member` — create user
- `npx tsx src/admin.ts add-email --user-id X --email Y --provider outlook` — link email
- `npx tsx src/admin.ts list-users` — show all users
```

Add to architecture section:
- Multi-user: users table, per-user email accounts, per-user briefings
- Dev request queue: `/request`, `/review`, `/approve`, `/reject`

- [ ] **Step 2: Update PROJECT_STATUS.md with what was done**

Append dated entry documenting multi-user implementation, new test count, and next steps.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md PROJECT_STATUS.md
git commit -m "docs: update CLAUDE.md and PROJECT_STATUS.md for multi-user architecture"
```

- [ ] **Step 4: Push to GitHub**

```bash
git push origin main
```
