# McSECREtary

AI secretary for Dearborn Denim team — multi-user email triage, daily briefings, dev request queue.

## Tech
- TypeScript (strict), Node.js, SQLite (better-sqlite3)
- Anthropic SDK: Haiku for classification, Sonnet for briefings
- Microsoft Graph API for Outlook email (single Azure AD app, client credentials)
- Grammy (Telegram bot) — single bot, per-user routing by chat_id
- Runs on Railway as persistent service with cron scheduling

## Architecture
- **Multi-user:** `users` table with per-user email accounts, preferences, and briefings
- **Auth:** Single Azure AD app with admin-consented client credentials (reads any mailbox in tenant)
- **Telegram:** One bot, routes messages by chat_id → user_id lookup
- **Dev requests:** Team members submit `/request`, Robert reviews/refines via `/approve`
- **Onboarding:** Admin creates user → generates invite code → user sends `/start <code>` to bot. Full playbook in [ONBOARDING.md](./ONBOARDING.md).

## Structure
- `src/config.ts` — env var loading
- `src/db/schema.ts` — SQLite schema init (calls user-schema.ts, calendar-schema.ts)
- `src/db/user-schema.ts` — users, email accounts, preferences, invites, dev_requests tables
- `src/db/user-queries.ts` — user CRUD, invite management, email account linking
- `src/db/request-queries.ts` — dev request CRUD, approval flow
- `src/db/queries.ts` — email + agent run queries (user-scoped)
- `src/db/calendar-queries.ts` — calendar queries (user-scoped)
- `src/db/conversation-queries.ts` — conversation log (user-scoped)
- `src/db/time-queries.ts` — time tracking (user-scoped)
- `src/db/seed-robert.ts` — seed Robert's user record + backfill existing data
- `src/db/seed-team.ts` — seed Olivier + Merab
- `src/auth/graph.ts` — MSAL token for Graph API
- `src/email/outlook.ts` — Outlook email fetcher
- `src/email/classifier.ts` — LLM email classification (Haiku)
- `src/email/actions.ts` — label, archive, move emails
- `src/briefing/generator.ts` — morning briefing (Sonnet, per-user context)
- `src/telegram/bot.ts` — per-user message sending (sendMessageToUser, sendBriefingToUser)
- `src/tools.ts` — 40+ Claude tools (user-scoped)
- `src/empire/request-sync.ts` — export approved dev requests for nightly plan
- `src/admin.ts` — CLI for user management
- `src/triage.ts` — per-user email triage pipeline
- `src/index.ts` — main entry, Telegram routing, scheduler

## Commands
- `npx tsx src/index.ts` — run the service (Telegram bot + scheduler)
- `npx vitest run` — run tests once
- `npx tsx src/admin.ts add-user --name X --email Y --role member` — create user + invite
- `npx tsx src/admin.ts add-email --user-id X --email Y --provider outlook` — link email account
- `npx tsx src/admin.ts set-preferences --user-id X --business-context "..."` — set context
- `npx tsx src/admin.ts list-users` — show all users
- `npx tsx src/admin.ts generate-invite --user-id X` — new invite code

## Users
- Robert McMillan (admin): rob@dearborndenim.com, robert@mcmillan-manufacturing.com
- Olivier (member): olivier@dearborndenim.com
- Merab (member): merab@dearborndenim.com

## Telegram Commands (all users)
- `briefing` — full email/calendar briefing
- `/request <description>` — submit dev request for nightly plan
- `/myrequests` — see your submitted requests
- `journal: <thoughts>` — log journal entry
- `/log <activity>` — log time
- `status` — time log

## Telegram Commands (admin only)
- `/review` — see pending dev requests
- `/approve <id> [refined description]` — approve request
- `/reject <id> <reason>` — reject request
- `/invite <user-email>` — generate a 7-day invite code for an existing user row
- `/onboard-all-pending` — bulk-mint + email invites for every entry in `pending_invites.json` (see ONBOARDING.md)
- `/onboarding-status [--pending-only]` — show pending vs onboarded invitees from `pending_invites.json` (20-per-section cap). `--pending-only` suppresses the Onboarded section.
- `/briefing-preview [--user=<name>] [--sections=<csv>]` — render tomorrow's 5 AM morning briefing immediately for QA (re-uses `runTriage` — no duplicate render path). `--user=<name>` previews the briefing as if for a named user (case-insensitive first-name match). `--sections=<csv>` renders only those sections (valid names: `overnight_dev`, `production`, `admin_ops`, `calendar`, `dev_requests`, `emails`, `stats`) — order in csv is honored. When **both** flags are present, `--sections` overrides the user's saved `briefing_sections_json` preference for the preview only (does NOT persist). Invalid section names return an error listing the valid set.
- `/briefing-sections --user=<name> (--set=<csv> | --reset | --list)` OR `/briefing-sections --list` — write, clear, or read the per-user `briefing_sections_json` preference. When set, that user's daily 5 AM briefing renders ONLY those sections **in the order the array was stored** (e.g., `--set=calendar,stats,emails` renders calendar first, then stats, then emails — overriding the default canonical order). `--reset` clears to NULL (full briefing, default behavior, default order). `--list` (with `--user`) shows that user's stored pref or `(default: full briefing)`. `--list` (bare, no `--user`) shows the canonical catalog of valid section names with one-line descriptions.
- `status <project>` — read PROJECT_STATUS.md from GitHub
- `feedback <project>: <text>` — append feedback
