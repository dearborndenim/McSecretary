# McSecretary — Project Status

## Vision
Full AI secretary for Robert. Autonomous email management across 2 Outlook accounts, daily briefings, calendar management, task tracking, time management, journaling/reflection, and eventually: agent empire coordination (route feedback to projects, compile overnight build reports, be the human-AI communication layer).

## Current Reality (last updated: 2026-04-21)
- **Deployment:** Railway (cron job) — GITHUB_TOKEN set on Railway for cross-repo access
- **GitHub:** github.com/dearborndenim/McSecretary
- **Communication:** Telegram bot for notifications and interaction with Robert
- **Email - Outlook (2 accounts):** Working — fetch, classify (Haiku), archive, categorize, bulk operations, send
- **Email - Gmail:** Removed per Robert. McSecretary is Outlook-only.
- **Email Classification:** Working — Haiku classifies spam/not-spam, auto-tags silently
- **Email Scanning:** Working — auto-scans every 30 min, bulk-tags via Graph batch API
- **Morning Briefing:** Working — Sonnet generates briefing, sent via Telegram. Now includes overnight dev report from NIGHTLY_PLAN.md via GitHub API.
- **Calendar:** Working — list, create, update, delete events (Outlook calendar)
- **Tasks/To-Do:** Working — Microsoft To Do integration (create, complete, list, track completions)
- **Task Polling:** Working — every 15 min, detects completed tasks, logs as time
- **Time Tracking:** Working — logs time from task completions and check-ins
- **Journaling:** Working — end-of-day reflection, weekly synthesis
- **Scheduler:** Working — configurable schedule for briefing, check-ins, evening summary, weekly synthesis
- **Tools for Claude:** 20+ tools (archive, categorize, bulk ops, calendar, tasks, schedule management)
- **Empire Coordination Tools:** Shipped — read_project_status, append_project_feedback, list_projects, get_nightly_plan
- **Contacts:** Working — read contacts from Outlook

## What's Missing for Full Secretary
- **Gmail integration:** Not needed -- dropped per Robert. Outlook-only.
- ~~**Agent Empire coordination:**~~ SHIPPED — read_project_status, append_project_feedback, list_projects, get_nightly_plan tools deployed
- ~~**Overnight build reporting:**~~ SHIPPED — morning briefing includes overnight dev report section via GitHub API
- **Business communications drafting:** Draft professional emails, customer responses
- **Meeting prep:** Prep notes for upcoming meetings from calendar + related emails
- **Document management:** Interface with SharePoint/OneDrive for filing
- **Proactive scheduling:** Suggest time blocks based on priorities and deadlines
- **Multi-brand support:** When new brands launch, secretary needs to manage comms for all brands

## Robert's Feedback
- 2026-04-10: "My secretary still needs to finish the full buildout"

## Iteration Backlog
1. ~~Add agent empire coordination~~ — DONE
2. ~~Integrate overnight build reporting into morning briefing~~ — DONE
4. Add meeting prep notes (pull relevant emails + docs before calendar events)
5. Add business communication drafting capability
6. Add proactive scheduling suggestions
7. Test and harden all 20+ tools for reliability

## Maturity: 95% → Full Secretary
Multi-user system + per-user schedules (timezone-aware, full scheduling-flow covered) + GitHub-backed nightly-plan pipeline + automated bulk onboarding + live WIP consumer + `/briefing-preview [--user=<name>]` admin dry-run + `/onboarding-status [--pending-only]`. 395 tests passing (35 new 2026-04-21). Email, calendar, briefings, dev request queue all user-scoped. Onboarding playbook shipped + `/onboard-all-pending` + `/onboarding-status` Telegram commands. Main gaps: business communication drafting, meeting prep, proactive scheduling.

### 2026-04-21: Multi-User Briefing — `/briefing-preview --user=<name>` + `/onboarding-status --pending-only` + TZ delivery-window coverage
Merged branch `feat/multi-user-briefing` to main. 35 new tests (360 → 395 passing), 0 failures, typecheck clean.

**Task 6.1 — `/briefing-preview --user=<name>`:**
- Extended the admin-only `/briefing-preview` command with an optional `--user=<name>` flag. Looks up the target user via case-insensitive first-name match on `users.name`. Unknown names return `No user named "X" found.` without running the render path.
- The render path is still `runTriage(db, targetUserId)` — one render path invariant holds (target defaults to the caller when the flag is absent).
- New `src/briefing/preview-command.ts` — pure `parseBriefingPreviewCommand(raw)` + `findUserByFirstName(db, name)` helpers. Keeps the parser unit-testable without pulling in config/Anthropic.
- 14 tests in `tests/briefing/briefing-preview-user-flag.test.ts` — parser matching (bare, `--user=X`, case, whitespace, rejecting bare args and empty flag values), name resolver (case fold, first-name only, unknown → undefined), wiring-source asserts (admin gate + parser + resolver imports present, unknown-name error branch present).

**Task 6.2 — Timezone regression suite expansion (full scheduling-flow for ET/PT):**
- New `tests/scheduler-delivery-windows-tz.test.ts` — simulates the actual 30-minute scheduler loop across a full UTC day (48 ticks) and asserts which moments cause each user's gate to open. Previously the TZ suite spot-checked a single UTC instant per user.
- 9 tests total: ET staff (check-in ticks match 7+8 AM ET = 11+12 UTC EDT, 7 AM CT is explicitly NOT the same as 7 AM ET, weekends skipped, EOD at 5 PM ET), PT staff (7-10 AM PT = 14-17 UTC PDT, 7 AM CT = 5 AM PT rejected, EOD 2:30 PM PT ≠ 2:30 PM CT), mixed fleet (ET+PT on same cron, each fires at their local 9 AM UTC tick, and at each local moment ONLY the correct user's gate opens).

**Task 6.3 — `/onboarding-status --pending-only`:**
- `src/onboarding/status.ts` gained `pendingOnly?: boolean` on `OnboardingStatusInput`. When set, the Onboarded section is suppressed entirely. Pending section still shows counts + `- none` when empty, and the "manifest missing" branch still fires when applicable.
- Empty-manifest short-circuit only fires for the default view; `--pending-only` still prints `Pending (0): - none` so the admin gets explicit zero feedback.
- New `parseOnboardingStatusCommand(raw)` pure parser (case-insensitive, whitespace-tolerant, strict on unknown flags).
- `readAndRenderOnboardingStatus(path, { pendingOnly })` passes the flag through.
- 12 tests in `tests/onboarding/status-pending-only.test.ts` — parser (bare, flag, case, whitespace, strict-unknown), render (onboarded section omitted, empty pending still surfaces, manifest-missing still works, no regression on default view), wiring-source asserts (parser imported + admin-gated).

**Files modified:**
- `src/index.ts` — parser-based handlers for `/briefing-preview` (with `--user=<name>`) and `/onboarding-status` (with `--pending-only`)
- `src/onboarding/status.ts` — `pendingOnly` + `parseOnboardingStatusCommand`
- `src/briefing/preview-command.ts` — new
- `CLAUDE.md` — admin command list reflects new flags
- `tests/briefing/briefing-preview-user-flag.test.ts` — new
- `tests/briefing/briefing-preview-command.test.ts` — admin-gate assertion updated for parser-based handler
- `tests/onboarding/status-pending-only.test.ts` — new
- `tests/scheduler-delivery-windows-tz.test.ts` — new

**No new env vars. No schema changes.**

### 2026-04-20: Briefing Quality Audit — /briefing-preview + flaky-test fix + staff timezone
Merged branch `nightly-2026-04-20-briefing-audit` to main. 24 new tests (336 → 360 passing), 0 failures, typecheck clean. The previously-flaky `tomorrow-preview` test is now deterministic.

**Task 6.1 — `/briefing-preview` admin command:**
- New admin-only Telegram command that re-runs `runTriage(db, userId)` — the EXACT same render path the 5 AM morning briefing uses. No duplicate render logic.
- Replies with a `[Preview — what tomorrow's 5 AM briefing will look like]` header followed by the full rendered briefing. Admin-gated via the existing `user.role === 'admin'` pattern.
- Wired into `src/index.ts` just before the public `/briefing` handler so the admin variant short-circuits first.
- 8 tests in `tests/briefing/briefing-preview-command.test.ts` — command parsing, case-insensitivity, strict equality, admin-gate, and source-inspection tests that guarantee the handler keeps calling `runTriage` (one render path invariant).

**Task 6.2 — Hardened flaky `tomorrow-preview` test:**
- Root cause: the test seeded events on `2026-04-17` but called `getTomorrowEventsPreview(db, 'u1')` with no explicit `now`, so the function defaulted to the wall-clock date. Any run where "today in CT" was not `2026-04-16` caused the Chicago-date filter to silently drop every seeded event.
- Fix: introduced `vi.useFakeTimers()` + `vi.setSystemTime(FROZEN_NOW)` in `beforeEach` of the original describe block.
- Added 5 deterministic boundary tests in a new describe block that each pass an explicit `now` arg to encode the specific scenarios that previously drifted: Friday evening → Saturday, late-night CT not leaking into tomorrow, month-end (Apr 30 → May 1), year-end (Dec 31 → Jan 1), DST spring-forward weekend (Mar 7 → Mar 8).

**Task 6.3 — Staff timezone support:**
- `scheduler-windows.ts` previously hard-coded `America/Chicago` when evaluating per-user cron gates, even though `users.timezone` was already persisted. That meant an ET user with `cron: '0 7 * * 1-5'` fired at 7 AM CT (= 8 AM ET).
- Added internal `getUserTimezone(db, userId)` helper that reads `users.timezone` (IANA string) and falls back to `America/Chicago` for NULL/empty rows — preserves legacy behavior.
- `shouldUserCheckInNow` + `shouldUserEodNow` now pass the resolved timezone to `isWithinCronWindow`. `isWithinCronWindow` itself was already timezone-parameterized (pure function).
- 9 new tests in `tests/scheduler-windows-timezone.test.ts` covering CT (baseline), ET (1h earlier), PT (2h later), UTC, 7 AM CT ≠ 7 AM ET boundary, EOD gate parity with check-in, NULL/empty-timezone legacy fallback, arbitrary IANA acceptance (Asia/Tokyo), and CT-is-still-default confirmation for newly-created users.

**Files modified:**
- `src/index.ts` — `/briefing-preview` handler
- `src/scheduler-windows.ts` — user-timezone aware gates
- `CLAUDE.md` — admin command list
- `tests/calendar/tomorrow-preview.test.ts` — fake timers + boundary scenarios
- `tests/briefing/briefing-preview-command.test.ts` — new
- `tests/scheduler-windows-timezone.test.ts` — new

**No new env vars.** Behavior is driven entirely by the existing `users.timezone` column.

### 2026-04-17: Onboarding Playbook + /start E2E Integration Test
- Added `ONBOARDING.md` — admin → invitee handoff sequence, invite-code
  semantics, role behavior, schedule-window backfill defaults, and
  failure/recovery modes.
- Referenced ONBOARDING.md from `CLAUDE.md` onboarding bullet.
- Verified `/start <code>` handler already does: `consumeInvite` →
  `linkTelegramChat` → welcome reply; schedule windows are NULL-coalesced
  to role-based defaults by `getUserScheduleWindows()` on first read
  (no explicit backfill INSERT needed).
- **Tests**: +5 integration tests in `tests/multi-user/start-flow-e2e.test.ts`
  covering member defaults, admin defaults, invalid code, expired code,
  and single-use invite enforcement. All 27 multi-user + schedule-windows
  tests still green.
- **Branch**: `feature/onboarding-docs` → merged to main.

### 2026-04-16: Multi-User System Implemented
- Added `users`, `user_email_accounts`, `user_preferences`, `user_invites`, `dev_requests` tables
- Added `user_id` to all 9 existing tables with backfill migration
- Per-user Telegram routing (chat_id → user_id lookup)
- Per-user email triage, briefing generation with dynamic system prompts
- `/start <invite_code>` for account linking
- `/request`, `/myrequests`, `/review`, `/approve`, `/reject` for dev request queue
- Admin CLI (`src/admin.ts`) for user management
- Seeded Robert (admin), Olivier (member), Merab (member)
- Morning briefings, hourly check-ins, evening summaries loop over all active users
- tools.ts passes userId through all tool executions
- 189 tests passing (up from 120), 0 failures
- **Still needs:** Create Railway persistent volume (mount `/data`), Olivier/Merab link Telegram accounts via `/start`

### 2026-04-15: Persistent Volume Configuration
- Updated railway.json with volume mount at `/data`
- Updated config.ts: DB_PATH default to `/data/secretary.db`
- Updated journal/files.ts: journal path to `/data/journal`
- **Still needs:** Create actual volume in Railway dashboard and attach to service

### 2026-04-16: Per-User Schedules + Nightly Plan Pipeline
Merged branch `schedules-and-pipeline` to main. 29 new tests (201 → 230), 0 failures, typecheck clean.

**Per-user schedule windows (Task A):**
- Added `check_in_cron` + `eod_cron` columns to `users` table with role-based defaults.
- Admin (Robert): check-ins every hour 6 AM–7 PM CT + EOD 7 PM, Mon-Fri.
- Members (Olivier/Merab): check-ins every hour 6 AM–2 PM CT + EOD 2:30 PM, Mon-Fri.
- New `src/scheduler-windows.ts` with pure cron matcher + `shouldUserCheckInNow` / `shouldUserEodNow` gates. Shared handler fires every 30 min; per-user cron gates which users actually receive each tick.
- End-of-day summary now includes `getTomorrowEventsPreview` (pulled from each user's Outlook calendar) + reflection prompt.
- Reply to EOD prompt is auto-saved to the user's `/data/journal/rob/<date>.md` file with `[EOD reflection]` tag.
- Seed scripts now set schedule windows on create and backfill them on existing rows with NULL values (volume wipe recovery).
- `ensureJournalDirs()` stubs `master-learnings.md` + `master-patterns.md` so morning briefings have something to load before the first weekly synthesis.

**Request→Nightly Plan pipeline (Task B):**
- New empire tools `update_nightly_plan` and `append_to_nightly_plan` push to `claude_code/NIGHTLY_PLAN.md` on GitHub under `## Next Session Priority Queue`.
- `/approve` now auto-calls `update_nightly_plan` so approved requests immediately reach the Foreman.
- `dev_requests.synced_at` column + `getApprovedUnsyncedDevRequests` + `markDevRequestSynced` prevent re-sync duplication.
- Updated `/Users/robertmcmillan/Documents/Claude/claude_code/PLANNER_INSTRUCTIONS.md` so the Foreman knows to treat `### Team Request #N:` entries as Priority Tier 1b.

**Enhanced briefing (Task C):**
- Admin morning briefing now includes pending dev requests via `formatPendingRequestsForBriefing` wired into `generateBriefing(pendingDevRequests)`.
- Production summary + overnight dev summary were already wired.
- Skipped: inventory/WIP from PO receiver (out of scope tonight).

**Still needs:** Telegram account linking for Olivier/Merab via `/start <code>`, Railway env var confirmation after volume wipe.

### 2026-04-18: Automated Onboarding + Live WIP Consumer
Merged branch `feature/onboard-auto-wip-consumer` to main. 41 new tests (260 → 301 passing), 0 new failures, typecheck clean. Pre-existing `tomorrow-preview.test.ts` flake unchanged.

**Automated onboarding (Task A+B+D):**
- New `src/onboarding/pending-invites.ts` — reads `pending_invites.json` at repo root, mints an invite per entry via existing `createInvite`, emails the code via new `sendInviteEmail`, stamps `onboarded_at` on success (idempotent re-runs). `user_not_found` and `email_failed` outcomes do NOT stamp `onboarded_at` so admin can fix and retry.
- New `src/email/invite-sender.ts` — reuses the existing Graph API `sendMail` path (same MSAL client-credentials flow McSecretary uses for reading email) when `INVITE_SENDER_EMAIL` is set. Falls back to stdout log when unset (safe local dev). Email body includes code, `/start` instructions, bot handle, and the 6 AM–2:30 PM CT schedule window policy for members.
- New admin Telegram command `/onboard-all-pending` wired into `src/index.ts`, admin-gated via the same `user.role === 'admin'` pattern as `/invite` / `/review` / `/approve`. Returns a per-invitee summary with totals.
- `pending_invites.json` seeded at repo root with Olivier + Merab.
- `ONBOARDING.md` updated with the new command, manifest schema, env vars, failure modes.

**Live WIP consumer (Task C):**
- `src/briefing/wip.ts` — stub replaced with real `GET /api/integration/wip-summary` fetch on piece-work-scanner. Bearer auth, 5s AbortSignal timeout (tighter than inventory's 10s because WIP fetch runs later in the briefing pipeline). Validates response shape (`total_in_flight`, `oldest_wip_age_hours`, `pieces_by_operation`, `as_of`); any non-2xx, timeout, or malformed JSON returns null so the admin briefing degrades to "WIP unavailable" instead of crashing.
- `formatWipSection` now renders as-of timestamp, total pieces in flight, oldest WIP age, and per-operation breakdown sorted descending so the biggest stage surfaces first.
- `tests/briefing/wip.test.ts` — 20 new tests covering formatter + fetch (happy path, blank config, 4xx, 5xx, network error, malformed payload, trailing-slash URL, 5s signal).
- Reuses the existing `PIECE_WORK_SCANNER_URL` / `PIECE_WORK_SCANNER_API_KEY` env vars already referenced by `briefing/production.ts`.

**New env vars (optional):**
- `INVITE_SENDER_EMAIL` — mailbox that sends invite emails via Graph. Unset → stdout stub (safe default).
- `TELEGRAM_BOT_HANDLE` — bot handle in invite emails. Defaults to `@mcsecretary_bot`.
- `SMTP_HOST=""` — explicit opt-out of Graph send (forces stdout stub).

**Still needs:** Admin runs `/onboard-all-pending` once Olivier/Merab are ready; `INVITE_SENDER_EMAIL` to be set on Railway (currently stdout stub); piece-work-scanner must ship the `/api/integration/wip-summary` endpoint on its side tonight for the live WIP data to flow.

### 2026-04-17: Admin Operations Snapshot in Morning Briefing
Merged branch `feature/briefing-inventory-wip` to main. 31 new tests (230 → 261), 0 new failures, typecheck clean. The pre-existing `tomorrow-preview.test.ts` flake is unchanged.

- Admin morning briefing now includes three operations sections: inventory on hand (total units, SKUs, top 5 low-stock), uninvoiced PO $ per brand, and WIP. Member briefings (Olivier/Merab) are unchanged — the sections are gated by `user.role === 'admin'` in `triage.ts`.
- New client modules: `src/briefing/inventory.ts`, `src/briefing/uninvoiced.ts`, `src/briefing/wip.ts`. Each fetches with Bearer auth + 10s timeout and returns null on any failure; formatters emit an "unavailable" line so the briefing never crashes.
- Inventory uses new `/api/integration/inventory-overview` endpoint added to purchase-order-receiver (also shipped tonight). Uninvoiced totals reuse the existing `/api/integration/cost-summary` feed.
- WIP is stubbed pending a `/integration/wip-summary` endpoint in piece-work-scanner (TODO in `src/briefing/wip.ts`).
- New env vars: `PO_RECEIVER_URL`, `PO_RECEIVER_API_KEY`.
- `generateBriefing` / `buildBriefingPrompt` gain an optional `adminOps` param; the Sonnet system prompt now lists an "Operations Snapshot" section admin-only.
