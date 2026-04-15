# McSecretary Multi-User Architecture Plan

**Date:** 2026-04-14
**Status:** Planning (not yet implemented)
**First users:** Robert McMillan (owner/admin), Olivier, Merab

---

## Current Architecture Summary

McSecretary is a single-user AI secretary running as a Railway cron job at 5 AM CT. Key characteristics:

- **Database:** Single SQLite file (`data/secretary.db`) with no user ownership on any table
- **Email:** Two Outlook accounts (`rob@dearborndenim.com`, `robert@mcmillan-manufacturing.com`) via Microsoft Graph API using a single Azure AD app registration with client credentials (app-level permissions, not delegated)
- **Telegram:** Single bot with a single hardcoded `TELEGRAM_CHAT_ID` -- all messages go to Robert
- **Briefing:** One briefing generated per run, tailored to Robert's businesses and context
- **Config:** All credentials are environment variables -- no per-user configuration exists
- **Auth:** Single `ConfidentialClientApplication` (MSAL) using client credentials flow -- the app has read access to both mailboxes via admin-consented app permissions

```
Current Data Flow:

  [Railway Cron 5AM]
         |
    [Fetch emails] --- Graph API (app credentials) ---> rob@dearborndenim.com
         |                                         \--> robert@mcmillan-manufacturing.com
         v
    [Classify with Haiku]
         |
         v
    [Generate briefing with Sonnet]
         |
         v
    [Send via Telegram] ---> Single chat (TELEGRAM_CHAT_ID)
         |
         v
    [Write to SQLite] --- No user_id on any row
```

---

## 1. Data Model Changes

### New Tables

```sql
-- Core user identity
CREATE TABLE users (
  id TEXT PRIMARY KEY,              -- UUID
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,       -- Primary email / login identity
  role TEXT NOT NULL DEFAULT 'member', -- 'admin' | 'member'
  telegram_chat_id TEXT,            -- Linked Telegram chat (nullable until linked)
  timezone TEXT NOT NULL DEFAULT 'America/Chicago',
  briefing_enabled INTEGER DEFAULT 1,
  briefing_cron TEXT DEFAULT '0 5 * * *',  -- Per-user schedule
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Team grouping (future-proofing, but useful immediately for shared mailboxes)
CREATE TABLE teams (
  id TEXT PRIMARY KEY,              -- UUID
  name TEXT NOT NULL,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now'))
);

-- Many-to-many: users belong to teams
CREATE TABLE team_members (
  team_id TEXT NOT NULL REFERENCES teams(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL DEFAULT 'member',  -- 'owner' | 'admin' | 'member'
  PRIMARY KEY (team_id, user_id)
);

-- Per-user email account connections
CREATE TABLE user_email_accounts (
  id TEXT PRIMARY KEY,              -- UUID
  user_id TEXT NOT NULL REFERENCES users(id),
  email_address TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'outlook',  -- 'outlook' | 'gmail' (future)
  -- OAuth tokens (encrypted at rest)
  access_token_encrypted TEXT,
  refresh_token_encrypted TEXT,
  token_expires_at TEXT,
  -- Azure-specific
  azure_tenant_id TEXT,
  -- Permissions
  is_shared_mailbox INTEGER DEFAULT 0,  -- Shared mailbox vs personal
  shared_with_team_id TEXT REFERENCES teams(id),  -- If shared, which team sees it
  enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, email_address)
);

-- Per-user briefing preferences
CREATE TABLE user_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  classifier_system_prompt TEXT,    -- Override for email classification context
  briefing_system_prompt TEXT,      -- Override for briefing generation context
  business_context TEXT,            -- "Owns Dearborn Denim and McMillan Manufacturing"
  vip_senders TEXT DEFAULT '[]',    -- JSON array of VIP email addresses
  quiet_categories TEXT DEFAULT '["junk","promotional","newsletter"]',
  updated_at TEXT DEFAULT (datetime('now'))
);
```

### Foreign Key Additions to Existing Tables

```sql
-- processed_emails: Add user ownership
ALTER TABLE processed_emails ADD COLUMN user_id TEXT REFERENCES users(id);

-- sender_profiles: Add user scoping (same sender may be VIP for one user, not another)
ALTER TABLE sender_profiles ADD COLUMN user_id TEXT REFERENCES users(id);
-- Drop old PRIMARY KEY (email), create new composite key:
-- PRIMARY KEY becomes (email, user_id)

-- agent_runs: Add user scoping
ALTER TABLE agent_runs ADD COLUMN user_id TEXT REFERENCES users(id);

-- audit_log: Add user context
ALTER TABLE audit_log ADD COLUMN user_id TEXT REFERENCES users(id);

-- calendar_events: Already has calendar_email, add user_id
ALTER TABLE calendar_events ADD COLUMN user_id TEXT REFERENCES users(id);

-- weekly_schedule: Add user scoping
ALTER TABLE weekly_schedule ADD COLUMN user_id TEXT REFERENCES users(id);

-- time_log: Add user scoping
ALTER TABLE time_log ADD COLUMN user_id TEXT REFERENCES users(id);

-- conversation_log: Add user scoping
ALTER TABLE conversation_log ADD COLUMN user_id TEXT REFERENCES users(id);

-- pending_actions: Add user scoping
ALTER TABLE pending_actions ADD COLUMN user_id TEXT REFERENCES users(id);
```

### Schema Diagram

```
+------------------+       +-------------------+       +----------------------+
|     users        |       |      teams        |       |   team_members       |
+------------------+       +-------------------+       +----------------------+
| id (PK)          |<------| owner_user_id(FK) |       | team_id (FK, PK)     |
| name             |       | id (PK)           |<------| user_id (FK, PK)     |
| email            |       | name              |       | role                 |
| role             |       +-------------------+       +----------------------+
| telegram_chat_id |               |
| timezone         |               |
| briefing_enabled |               |
| briefing_cron    |               |
+------------------+               |
        |                          |
        |   +----------------------+-------------------+
        |   |                                          |
        v   v                                          |
+-------------------------+                            |
| user_email_accounts     |                            |
+-------------------------+                            |
| id (PK)                 |                            |
| user_id (FK -> users)   |                            |
| email_address            |                            |
| access_token_encrypted  |                            |
| refresh_token_encrypted |                            |
| token_expires_at        |                            |
| is_shared_mailbox       |                            |
| shared_with_team_id (FK)|----------------------------+
| enabled                 |
+-------------------------+
        |
        v
+--------------------+     +--------------------+     +--------------------+
| processed_emails   |     | calendar_events    |     | conversation_log   |
+--------------------+     +--------------------+     +--------------------+
| id (PK)            |     | id (PK)            |     | id (PK)            |
| user_id (FK) [NEW] |     | user_id (FK) [NEW] |     | user_id (FK) [NEW] |
| account            |     | calendar_email     |     | date               |
| sender, subject... |     | title, start_time..|     | role, message      |
+--------------------+     +--------------------+     +--------------------+
```

---

## 2. Telegram: Single Bot with Per-User Conversations vs. Separate Bots

### Option A: Single Bot, Per-User Conversations

**How it works:** One Telegram bot. Each user starts a private chat with the same bot. The bot maps `chat_id` to `user_id` in the database and routes messages accordingly.

**Pros:**
- Single bot token to manage
- One webhook/polling endpoint
- Users join by messaging the bot and running `/start` -- simple onboarding
- Easy to add new users without deploying new infrastructure
- Robert can manage all users from one admin interface

**Cons:**
- Bot has access to all users' conversations (inherent to single-bot design)
- If bot token is compromised, all users are exposed
- Rate limits are shared across all users (Telegram allows ~30 msgs/sec per bot)

### Option B: Separate Bots Per User

**How it works:** Each user gets their own Telegram bot (created via BotFather). Each bot runs independently.

**Pros:**
- Total isolation between users
- Independent rate limits
- If one bot token leaks, others unaffected

**Cons:**
- Managing N bot tokens and N webhook endpoints
- Config complexity scales linearly with users
- No centralized admin view
- Creating a new bot for each user is manual overhead

### Recommendation: Option A -- Single Bot

For a small team (3 users, growing slowly), a single bot is vastly simpler. The rate limit concern is irrelevant at this scale. The security risk of a shared bot token is acceptable because all three users are trusted team members in the same organization.

### Routing Implementation

```
[Telegram message arrives]
        |
        v
  [Extract chat_id from update]
        |
        v
  [Lookup user_id by telegram_chat_id in users table]
        |
    Found?
   /      \
  Yes      No
  |         \
  v          v
[Route to    [Reply: "Not registered.
 user's       Use /start <invite_code>
 context]     to link your account."]
```

### Account Linking Flow

1. Robert creates a user record in the database (via admin command or CLI)
2. System generates a one-time invite code stored in a `user_invites` table
3. New user messages the bot: `/start <invite_code>`
4. Bot validates the code, stores the user's `chat_id` in the `users` table
5. Bot replies: "Linked! You'll receive briefings here."
6. Invite code is marked as used

```sql
CREATE TABLE user_invites (
  code TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  used_at TEXT
);
```

### Bot Code Changes

The current `bot.ts` uses a module-level singleton `chatId`. This must change to accept a `userId` or `chatId` parameter:

```typescript
// Current (single-user):
export async function sendMessage(text: string): Promise<void> {
  await bot.api.sendMessage(getChatId(), text);
}

// Multi-user:
export async function sendMessage(userId: string, text: string): Promise<void> {
  const chatId = await getChatIdForUser(userId);
  if (!chatId) throw new Error(`No Telegram chat linked for user ${userId}`);
  await bot.api.sendMessage(chatId, text);
}
```

---

## 3. Email Integration: Per-User OAuth Tokens

### Current State

The app uses **client credentials flow** (app-level permissions) with a single Azure AD app registration. This grants the app access to any mailbox in the tenant without user interaction. The two email addresses are hardcoded in env vars (`OUTLOOK_USER_EMAIL_1`, `OUTLOOK_USER_EMAIL_2`).

### Target State

Each user connects their own email account(s). Two approaches exist:

### Approach A: Stay with Client Credentials (Admin-Consented App Permissions)

If all users are in the same Azure AD tenant (Dearborn Denim / McMillan Manufacturing), the existing client credentials flow already works. The app can read any mailbox in the tenant. We just need to store which email addresses belong to which user.

**Pros:** No per-user OAuth flow needed. Simplest path.
**Cons:** Only works for users in the same tenant. The app has access to ALL mailboxes in the tenant, not just the ones it should.

### Approach B: Delegated OAuth2 (Authorization Code Flow)

Each user completes an OAuth2 consent flow. The app stores per-user refresh tokens and exchanges them for access tokens on each run.

**Pros:** Works across tenants. Follows least-privilege -- app only accesses mailboxes the user explicitly granted.
**Cons:** Requires a web-based OAuth callback endpoint. Refresh tokens need secure storage and renewal.

### Recommendation: Approach A for Now, Approach B as Future Enhancement

Since Olivier and Merab are likely in the same Azure AD tenant, client credentials flow works immediately. We just need to track email-to-user mappings in the database instead of env vars.

If cross-tenant support is needed later, add delegated OAuth as a second auth path.

### Graph API Client Changes

```typescript
// Current (single app-level token):
export async function getGraphToken(): Promise<string> {
  const client = getMsalClient();
  const result = await client.acquireTokenByClientCredential({...});
  return result.accessToken;
}

// Multi-user (token per user's email accounts):
export async function getGraphTokenForUser(userId: string): Promise<string> {
  const accounts = getUserEmailAccounts(userId);

  // If all accounts are same-tenant, reuse client credentials
  // If cross-tenant, use stored refresh token for delegated flow
  if (accounts[0].provider === 'outlook' && !accounts[0].refresh_token_encrypted) {
    // Client credentials flow (same tenant)
    return getAppLevelToken();
  } else {
    // Delegated flow (cross-tenant, future)
    return refreshDelegatedToken(accounts[0]);
  }
}
```

### Email Fetching Changes

```typescript
// Current:
await fetchUnreadOutlookEmails('rob@dearborndenim.com', since);
await fetchUnreadOutlookEmails('robert@mcmillan-manufacturing.com', since);

// Multi-user:
for (const user of activeUsers) {
  const accounts = getUserEmailAccounts(user.id);
  for (const account of accounts) {
    const token = await getGraphTokenForUser(user.id);
    const emails = await fetchUnreadOutlookEmails(account.email_address, since, token);
    // Tag each email with user.id before storing
  }
}
```

### Token Storage Security

- Encrypt tokens at rest using a `TOKEN_ENCRYPTION_KEY` env var (AES-256-GCM)
- Never log tokens
- Rotate encryption key via re-encryption migration if compromised
- For client credentials flow, the existing single token is fine -- no per-user tokens needed

---

## 4. Briefing Isolation

### Current State

One briefing is generated per cron run. The `BRIEFING_SYSTEM_PROMPT` is hardcoded with Robert's business context. The `buildBriefingPrompt()` function takes all classified emails and formats them into a single prompt.

### Multi-User Briefing Pipeline

```
[Cron triggers at scheduled time]
        |
        v
  [Load all active users with briefing_enabled = 1]
        |
        v
  [For each user, IN PARALLEL:]
     |
     +---> [Fetch emails for THIS user's accounts only]
     +---> [Classify emails with user's context]
     +---> [Fetch calendar for THIS user's calendars only]
     +---> [Load overnight dev summary (shared or per-user)]
     |
     v
  [Generate briefing with user's preferences:]
     - System prompt includes user's business_context
     - Only this user's emails/calendar/data
     |
     v
  [Send to THIS user's Telegram chat_id]
```

### What Is User-Specific vs. Shared

| Data | Scope | Notes |
|------|-------|-------|
| Email accounts | Per-user | Each user sees only their own mailboxes |
| Classified emails | Per-user | Emails tagged with `user_id` at ingest |
| Calendar events | Per-user | Each user's calendars fetched separately |
| Briefing content | Per-user | Generated from user's data + preferences |
| Sender profiles | Per-user | Same sender may have different VIP status per user |
| Conversation log | Per-user | Telegram conversations are inherently per-user |
| Overnight dev summary | Shared | The Foreman's NIGHTLY_PLAN.md is a team resource |
| Time log | Per-user | Each user tracks their own time |
| Agent run stats | Per-user | Track costs per user |

### Briefing Generator Changes

```typescript
// Current signature:
export async function generateBriefing(
  emails: ClassifiedEmail[],
  stats: BriefingStats,
  calendar?: CalendarBriefingData,
  overnightDevSummary?: string,
): Promise<string>

// Multi-user signature:
export async function generateBriefing(
  userId: string,
  emails: ClassifiedEmail[],       // Pre-filtered to this user
  stats: BriefingStats,            // This user's stats
  calendar?: CalendarBriefingData, // This user's calendar
  overnightDevSummary?: string,    // Shared
  preferences?: UserPreferences,   // This user's custom context
): Promise<string>
```

The system prompt becomes dynamic, loaded from `user_preferences.briefing_system_prompt` with a fallback to the current hardcoded prompt. The `business_context` field replaces the hardcoded "Rob owns Dearborn Denim and McMillan Manufacturing" text.

### Classifier Changes

Similarly, the classifier system prompt currently says "You are an email triage assistant for Robert McMillan, who owns: Dearborn Denim..." This must become dynamic:

```typescript
function getClassifierPrompt(user: User, preferences: UserPreferences): string {
  return `You are an email triage assistant for ${user.name}.

${preferences.business_context}

Your job is to classify incoming emails...`;
}
```

---

## 5. Onboarding Checklist

### Prerequisites

- Multi-user schema migration has been run
- Robert's existing data has been migrated (see Section 6)
- Robert has admin role in the `users` table

### Step-by-Step: Adding Olivier

1. **Robert creates Olivier's user record** (via CLI or admin Telegram command):

   ```bash
   # CLI approach:
   npx tsx src/admin.ts add-user \
     --name "Olivier" \
     --email "olivier@dearborndenim.com" \
     --role member \
     --timezone "America/Chicago"
   ```

   This inserts a row into `users` and generates an invite code.

2. **Robert sends Olivier the invite code** (via Slack, text, whatever):

   > "Message @McSecretaryBot on Telegram with: /start abc123-invite-code"

3. **Olivier opens Telegram, finds @McSecretaryBot, sends `/start abc123-invite-code`:**

   The bot validates the code, links Olivier's `chat_id`, and replies:
   > "Welcome, Olivier! You're linked. Let's set up your email."

4. **Connect Olivier's email account(s):**

   If Olivier is in the same Azure AD tenant (client credentials flow):
   ```bash
   npx tsx src/admin.ts add-email \
     --user-id <olivier-uuid> \
     --email "olivier@dearborndenim.com" \
     --provider outlook
   ```
   No OAuth needed -- the app already has tenant-wide access.

   If Olivier is in a different tenant (delegated flow, future):
   ```bash
   npx tsx src/admin.ts add-email \
     --user-id <olivier-uuid> \
     --email "olivier@external.com" \
     --provider outlook \
     --oauth
   ```
   This generates a one-time OAuth URL. Olivier clicks it, consents, and the app stores the refresh token.

5. **Set Olivier's business context:**

   ```bash
   npx tsx src/admin.ts set-preferences \
     --user-id <olivier-uuid> \
     --business-context "Olivier manages operations at Dearborn Denim. Focus areas: production scheduling, vendor management, quality control."
   ```

6. **Verify setup:**

   ```bash
   npx tsx src/admin.ts test-briefing --user-id <olivier-uuid>
   ```

   This fetches Olivier's emails, classifies them, generates a test briefing, and sends it to his Telegram chat. He confirms he received it.

7. **Enable daily briefing:**

   Olivier's `briefing_enabled` is already `1` by default. If he wants a different time:
   ```bash
   npx tsx src/admin.ts set-preferences \
     --user-id <olivier-uuid> \
     --briefing-cron "0 6 * * *"  # 6 AM instead of 5 AM
   ```

### Repeat for Merab

Same steps. Replace Olivier's details with Merab's.

### Quick Reference: Admin Commands

| Command | Description |
|---------|-------------|
| `add-user --name --email --role --timezone` | Create user, generate invite code |
| `add-email --user-id --email --provider` | Link email account to user |
| `set-preferences --user-id [options]` | Set business context, VIP senders, etc. |
| `test-briefing --user-id` | Run a test briefing for one user |
| `list-users` | Show all users and their linked accounts |
| `revoke-user --user-id` | Disable user, revoke tokens, unlink Telegram |
| `generate-invite --user-id` | Generate new invite code for Telegram linking |

---

## 6. Migration Path

### Principle: Zero Downtime for Robert

Robert's existing setup must continue working throughout the migration. The migration is additive -- no existing columns are removed, no existing env vars stop working.

### Migration Phases

#### Phase 1: Schema Addition (Non-Breaking)

Run the migration that creates new tables (`users`, `teams`, `user_email_accounts`, etc.) and adds `user_id` columns to existing tables. The `user_id` columns are nullable, so existing queries continue to work.

```sql
-- Migration 001_multi_user.sql

-- Create new tables (see Section 1)
CREATE TABLE IF NOT EXISTS users (...);
CREATE TABLE IF NOT EXISTS teams (...);
CREATE TABLE IF NOT EXISTS team_members (...);
CREATE TABLE IF NOT EXISTS user_email_accounts (...);
CREATE TABLE IF NOT EXISTS user_preferences (...);
CREATE TABLE IF NOT EXISTS user_invites (...);

-- Add user_id to existing tables (nullable for backwards compat)
ALTER TABLE processed_emails ADD COLUMN user_id TEXT REFERENCES users(id);
ALTER TABLE sender_profiles ADD COLUMN user_id TEXT REFERENCES users(id);
ALTER TABLE agent_runs ADD COLUMN user_id TEXT REFERENCES users(id);
ALTER TABLE audit_log ADD COLUMN user_id TEXT REFERENCES users(id);
ALTER TABLE calendar_events ADD COLUMN user_id TEXT REFERENCES users(id);
ALTER TABLE weekly_schedule ADD COLUMN user_id TEXT REFERENCES users(id);
ALTER TABLE time_log ADD COLUMN user_id TEXT REFERENCES users(id);
ALTER TABLE conversation_log ADD COLUMN user_id TEXT REFERENCES users(id);
ALTER TABLE pending_actions ADD COLUMN user_id TEXT REFERENCES users(id);
```

#### Phase 2: Seed Robert's User Record

```sql
-- Migration 002_seed_robert.sql

INSERT INTO users (id, name, email, role, telegram_chat_id, timezone)
VALUES (
  'robert-mcmillan-uuid',
  'Robert McMillan',
  'rob@dearborndenim.com',
  'admin',
  '<current TELEGRAM_CHAT_ID value>',
  'America/Chicago'
);

INSERT INTO user_email_accounts (id, user_id, email_address, provider)
VALUES
  ('acct-1-uuid', 'robert-mcmillan-uuid', 'rob@dearborndenim.com', 'outlook'),
  ('acct-2-uuid', 'robert-mcmillan-uuid', 'robert@mcmillan-manufacturing.com', 'outlook');

INSERT INTO user_preferences (user_id, business_context)
VALUES (
  'robert-mcmillan-uuid',
  'Robert McMillan owns Dearborn Denim (rob@dearborndenim.com) — a denim/jeans company, and McMillan Manufacturing (robert@mcmillan-manufacturing.com) — contract manufacturing.'
);

-- Backfill user_id on existing data
UPDATE processed_emails SET user_id = 'robert-mcmillan-uuid' WHERE user_id IS NULL;
UPDATE sender_profiles SET user_id = 'robert-mcmillan-uuid' WHERE user_id IS NULL;
UPDATE agent_runs SET user_id = 'robert-mcmillan-uuid' WHERE user_id IS NULL;
UPDATE audit_log SET user_id = 'robert-mcmillan-uuid' WHERE user_id IS NULL;
UPDATE calendar_events SET user_id = 'robert-mcmillan-uuid' WHERE user_id IS NULL;
UPDATE weekly_schedule SET user_id = 'robert-mcmillan-uuid' WHERE user_id IS NULL;
UPDATE time_log SET user_id = 'robert-mcmillan-uuid' WHERE user_id IS NULL;
UPDATE conversation_log SET user_id = 'robert-mcmillan-uuid' WHERE user_id IS NULL;
UPDATE pending_actions SET user_id = 'robert-mcmillan-uuid' WHERE user_id IS NULL;
```

#### Phase 3: Dual-Mode Code

Update the application code to work in both modes during transition:

```typescript
// config.ts: Keep existing env vars working
export const config = {
  // ... existing config ...

  // Multi-user mode: enabled when users table has rows
  // Falls back to env-var-based single-user mode otherwise
  multiUser: {
    enabled: optional('MULTI_USER_ENABLED', 'false') === 'true',
  },
};
```

```typescript
// index.ts: Main entry point
if (config.multiUser.enabled) {
  // Multi-user path: iterate over all users
  const users = getActiveUsers(db);
  for (const user of users) {
    await runPipelineForUser(db, user);
  }
} else {
  // Legacy single-user path: use env vars (existing behavior)
  await runLegacyPipeline(db);
}
```

#### Phase 4: Cut Over

Once multi-user code is tested and Robert's briefings work correctly through the new path:

1. Set `MULTI_USER_ENABLED=true` in Railway env vars
2. Monitor for one week
3. Remove legacy single-user code path
4. Make `user_id` columns NOT NULL (with a migration that drops and recreates tables, since SQLite doesn't support `ALTER COLUMN`)

### Rollback Plan

If anything breaks after enabling multi-user mode:
1. Set `MULTI_USER_ENABLED=false` in Railway
2. The app falls back to the legacy code path immediately
3. No data migration needed -- the legacy path ignores the new `user_id` columns

---

## 7. Security Boundaries

### User Roles and Permissions

| Permission | Admin (Robert) | Member (Olivier, Merab) |
|-----------|----------------|------------------------|
| View own emails/briefings | Yes | Yes |
| View other users' emails | Yes (audit only) | No |
| View other users' briefings | Yes (audit only) | No |
| Add/remove users | Yes | No |
| Link email accounts (own) | Yes | Yes |
| Link email accounts (others) | Yes | No |
| Modify own preferences | Yes | Yes |
| Modify others' preferences | Yes | No |
| View audit log | Yes | No |
| View agent run stats | All users | Own only |
| Access shared mailboxes | Per team config | Per team config |

### Data Isolation Rules

1. **Email data is strictly user-scoped.** Queries MUST include `WHERE user_id = ?` for all email-related operations. No exceptions.

2. **Sender profiles are per-user.** The same sender (e.g., a vendor) may be classified differently by different users. Sender VIP status is per-user.

3. **Calendar events are per-user.** Even if two users share a calendar (e.g., team calendar), each user's view of it is stored separately with their `user_id`.

4. **Conversation logs are per-user.** Telegram conversations are inherently isolated by chat, but the database must also enforce it via `user_id`.

5. **Shared data is explicitly marked.** The only shared data is:
   - Team membership (visible to team members)
   - Shared mailbox access (team-level, not individual)
   - Overnight dev summary (read-only, same for everyone)

### Query Safety

All database query functions must be updated to require `userId` as a parameter:

```typescript
// BEFORE (unsafe -- returns all emails):
export function getRecentEmails(db: Database.Database): ProcessedEmail[] {
  return db.prepare('SELECT * FROM processed_emails ORDER BY received_at DESC LIMIT 50').all();
}

// AFTER (user-scoped):
export function getRecentEmails(db: Database.Database, userId: string): ProcessedEmail[] {
  return db.prepare(
    'SELECT * FROM processed_emails WHERE user_id = ? ORDER BY received_at DESC LIMIT 50'
  ).all(userId);
}
```

### Audit Logging

Every data access and action must be logged with:

```sql
INSERT INTO audit_log (user_id, action_type, target_id, target_type, details, confidence, approved_by)
VALUES (?, ?, ?, ?, ?, ?, ?);
```

Key events to log:
- User created/modified/disabled
- Email account linked/unlinked
- Briefing generated and sent
- Email classified and action taken
- Admin accessed another user's data
- Failed authentication/authorization attempts
- Telegram account linked/unlinked

### Telegram Security

- The bot should only respond to messages from linked `chat_id`s
- Unrecognized `chat_id`s get a generic "Not registered" response -- do not leak information about what the bot does
- Invite codes expire after 24 hours and are single-use
- Admin commands (e.g., `/admin list-users`) are only available to users with `role = 'admin'`

### Token Security

- OAuth refresh tokens stored in `user_email_accounts` MUST be encrypted at rest using AES-256-GCM
- Encryption key stored as `TOKEN_ENCRYPTION_KEY` env var in Railway (never in code or database)
- Token decryption happens in-memory only, never written to logs
- Implement token rotation: refresh tokens are re-encrypted after each use with a fresh IV

---

## Implementation Priority

Recommended build order:

1. **Database migration** (Phase 1 + 2) -- schema changes, seed Robert
2. **Telegram bot updates** -- invite codes, per-user routing, `/start` flow
3. **Email pipeline user-scoping** -- `user_id` on all queries, per-user email fetching
4. **Briefing generator** -- dynamic system prompts, per-user preferences
5. **Admin CLI** (`src/admin.ts`) -- user management commands
6. **Feature flag cutover** -- `MULTI_USER_ENABLED=true`
7. **Onboard Olivier and Merab** -- real-world validation
8. **Remove legacy code path** -- clean up dual-mode logic

Estimated effort: 3-4 nightly build sessions.
