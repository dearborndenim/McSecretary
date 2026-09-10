# McSECREtary

AI secretary for Dearborn Denim team — multi-user email triage, daily briefings, dev request queue.

## Tech
- TypeScript (strict), Node.js, SQLite (better-sqlite3)
- Anthropic SDK (`@anthropic-ai/sdk`): model IDs are hardcoded per call site — Haiku for the per-email classifier and cleanup scan, Sonnet for the chat agent, email scan, briefing, reflection, and synthesis. Search for `model:` to find every pin.
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
- `src/tools.ts` — core Claude tools (email, calendar, To Do, schedule, journal) plus the empire tools re-exported from `src/empire/tools.ts`; `TOOL_DEFINITIONS` is the source of truth for the count.
- `src/chat-prompt.ts` — per-user chat system prompt builder (stable cached block + volatile context block)
- `src/empire/request-sync.ts` — export approved dev requests to NIGHTLY_PLAN.md (file is a queue only; nightly build deactivated)
- `src/admin.ts` — CLI for user management
- `src/triage.ts` — per-user email triage pipeline
- `src/lions/` — South Loop Lions schedule checker (CPS SCORE! sheet → diff → Telegram alert → public team page)
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
- `/request <description>` — submit a dev request to the admin review queue (approved requests can be exported to NIGHTLY_PLAN.md, which no automated build currently consumes)
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
- `/briefing-sections --user=<name> (--set=<csv> | --reset | --list | --diff | --clone-from=<src> | --history [--days=N] | --revert)` OR `/briefing-sections --list` OR `/briefing-sections --set-all=<csv> --apply-to=all` — write, clear, read, diff, clone, view-history, revert, or bulk-set the per-user `briefing_sections_json` preference. When set, that user's daily 5 AM briefing renders ONLY those sections **in the order the array was stored** (e.g., `--set=calendar,stats,emails` renders calendar first, then stats, then emails — overriding the default canonical order). `--reset` clears to NULL (full briefing, default behavior, default order). `--list` (with `--user`) shows that user's stored pref or `(default: full briefing)`. `--list` (bare, no `--user`) shows the canonical catalog of valid section names with one-line descriptions. `--diff` (with `--user`) shows that user's pref vs full briefing — `Current:`, `Missing:`, `Order:` lines (NULL pref → `Current: (default: full briefing)`, `Missing: (none)`); unknown user → `User '<name>' not found. Use /onboarding-status for the list.`. `--clone-from=<src>` (with `--user=<target>`) copies the source user's stored briefing prefs onto the target verbatim — NULL source → resets target to default-full-briefing; unknown source → `User '<src>' not found.`; unknown target → `User '<target>' not found.`; cloning to self → `Cannot clone-from self.`; success → `Cloned briefing prefs from '<src>' to '<target>'. Sections: <csv | (default: full briefing)>`. `--history --user=<name> [--days=N]` lists audit rows for that user newest-first (one line per row: `YYYY-MM-DD HH:MM <action> [from <source_user>] sections=<csv | (default)>`). Days default 7, clamp [1, 90] (audit pruned at 90d). Empty case → `No audit history for '<name>' in last <N> day(s).`. `--revert --user=<name>` undoes the most-recent action by writing the prior `sections_json` from the audit log (the 2nd-most-recent row); writes itself as a new audit row with `action=revert`; <2 rows → `No prior briefing-sections action to revert for '<name>'.`. `--set-all=<csv> --apply-to=all` writes the same section preference to every onboarded (briefing-enabled) user; lists up to 20 names then `...and K more` when >20; `--apply-to` MUST be `all` (anything else is rejected by the parser). Every `--set` / `--reset` / `--set-all` / `--clone-from` / `--revert` write emits a row to `briefing_sections_audit` (auto-pruned >90d on every insert via `BRIEFING_AUDIT_RETENTION_DAYS`, default 90, clamp [1, 3650]); the daily 7 AM CT "Briefing Audit Digest" job summarizes the last 24h of changes (empty case = silent; opt-out via `DISABLE_BRIEFING_AUDIT_DIGEST=1`; recipient configured via `BRIEFING_AUDIT_DIGEST_RECIPIENT`).
- `/lions` — South Loop Lions schedule (stored snapshot) plus any active schedule-change alerts
- `status <project>` — read PROJECT_STATUS.md from GitHub
- `feedback <project>: <text>` — append feedback

## South Loop Lions schedule checker (`src/lions/`)
Robert coaches the South Loop Lions (CPS SCORE! 7/8th boys, Network 6, Blue Conference). CPS edits game times and opponents in the master Google Sheet without telling anyone, so McSecretary watches it.

- Flow: `check.ts` fetches the sheet's CSV export (10 s timeout) → `parse.ts` reads the `(N6) Crane HS` tab → `diff.ts` compares against the last snapshot **by week** → `store.ts` writes `lions_schedule_snapshots` / `lions_alerts` → ONE Telegram message to Robert per change set (`sendMessage`, plain text).
- Fails closed: a network error, non-2xx, parse failure, or a suspiciously short sheet (under 3 Lions games when the previous snapshot had 6+) returns `{ ok:false, error }` and **never** overwrites the snapshot — a bad fetch must not read as "CPS deleted all six games". First run stores a baseline and alerts nothing. A sheet edit that misses our games saves a snapshot silently.
- Cron (both in `initializeDefaultSchedule`, America/Chicago): `Lions Schedule Check` `0 6,12,18 * * *` and `Lions Schedule Check (Fri PM)` `0 20 * * 5`.
- Routes (mounted from `src/api.ts` before the legacy routes, see `setLionsHttpHandler`): `GET /lions` (public team page, live JSON injected into its `<script id="lions-data">` block, `no-store`), `GET /lions/schedule.json` (public), `POST /lions/check` and `POST /lions/alerts/clear` (bearer `API_SECRET`, same gate as `/api/sms`).
- The page (`src/lions/page.html`) is a standalone artifact: with `live:false` it renders its own static schedule, with live games it swaps the `kind:"game"` rows (keeping the kicks/open-house rows so conflict detection still works) and pops a red `SCHEDULE CHANGE` banner for active alerts, dismissals remembered per device in `localStorage`. It is read from `src/` at runtime — there is no build step, so nothing needs copying to `dist`.
- Env (all optional, defaults in `src/lions/config.ts`): `LIONS_SHEET_ID`, `LIONS_SHEET_GID`, `LIONS_TEAM` (`SOUTH LOOP`), `LIONS_VENUE` (`Crane HS`), `LIONS_BASE_URL` (falls back to `BASE_URL`; when unset the alert just omits the "Live page" line).

## Spine (agent-graph inbox)
McSecretary is the human inbox for the business agents. Agents (Claude Code sessions) file **proposals** over HTTP; McSecretary routes each through the **trust ledger** — execute it against a **hand** (a deterministic service named in `config/brands/<brand>.json`) or send a Telegram card with Approve / Edit / Reject. Hands never call the model; McSecretary never decides on its own.

- Code: `src/spine/` (router, executor, telegram-card + `InboxTransport`, api-routes, jobs, promote-command, wiring, gates, edits, brand-config, agent-keys), `src/db/*-queries.ts` for proposals/trust/events/outcomes/run-index, `src/db/spine-schema.ts`.
- Endpoints: `/spine/proposals`, `/spine/events`, `/spine/events/drain`, `/spine/outcomes`, `/spine/runs`, `/spine/brands/:id`, `/spine/trust`. Auth: `Authorization: Bearer <key>` where the key is listed in `AGENT_KEYS=agent:key,…` — the agent name comes from the key, never from the body.
- Read-only hand proxy: `GET /spine/hands/:hand/<path>?brand=<id>&…` forwards the GET to the hand with the hand's bearer (agent never holds it); other query params pass through; non-GET → 405, unknown brand/hand or missing env → 404, path leaving the hand origin (incl. `%2f`/`%2e`) → 400, non-2xx upstream or a body over 1 MiB (streamed, never truncated) → 502 `{hand_status}`; timeout is the hand timeout from wiring (20 s default).
- Pending counts: `GET /spine/events/pending?types=a,b` → `{ counts: { a: { pending, urgent }, … } }` — non-mutating (unlike `/spine/events/drain`); max 50 types of ≤128 chars.
- Proposals accept optional `run_id` (1–128 chars) linking to `agent_run_index.run_id`; stored in `proposals.run_id` (nullable, PRAGMA-gated additive migration in `spine-schema.ts`).
- Human gates in `src/spine/gates.ts` are pinned at level 1 forever. Add an action type there before an agent may use it as a gate.
- Adding a hand: add `{ "url_env", "key_env" }` under `hands` in the brand file and set those env vars on Railway. The executor refuses any path that leaves the hand's origin.
- Built-in `notes` hand: for card-only decisions with no hand to call (capacity warnings, schedule changes, variance reports, restock flags, ...). File `action_payload: { hand: 'notes', method: 'POST', path: '/note', body: { title, summary, notify?, details? } }` — `title` ≤120 chars, `summary` ≤2000 chars, optional `notify` ≤600 chars, optional `details` object. No brand config entry is needed (works for every brand unless it registers its own `hands.notes`, which then wins). The executor never makes an HTTP call for it — it records the body as a 200 response directly — and the Telegram card renders `title`/`summary` in place of the usual `action_type → hand/path` line. `extractNotify` forwards `body.notify`, or `title: summary` when `notify` is absent, into the executed/report message. Because a note is inherently reversible at $0 cost, a level-3 trust promotion on a `notes` action type makes it auto-execute silently (no card, no report) — treat promoting a notes action type to level 3 as "stop telling me about this," not as approving a payment or a write.
- Adding a brand: add `config/brands/<brand_id>.json` (lowercase slug filename = `brand_id`), a user row for its `inbox_user_id` with a linked Telegram chat.
- Executed proposals emit `<action_type>_executed` events for the urgent poll (best-effort, never fails the execution; suppressed for pure-card `notes` proposals whose action type ends `_report`/`_warning`/`_alert`/`_flag`; `sourcing_option` also emits `sourcing_options_executed`).
- Never `git add -A` after running the suite (journal test side effect, see PROJECT_STATUS).
