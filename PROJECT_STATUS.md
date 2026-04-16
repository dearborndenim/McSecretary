# McSecretary — Project Status

## Vision
Full AI secretary for Robert. Autonomous email management across 2 Outlook accounts, daily briefings, calendar management, task tracking, time management, journaling/reflection, and eventually: agent empire coordination (route feedback to projects, compile overnight build reports, be the human-AI communication layer).

## Current Reality (last updated: 2026-04-11)
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

## Maturity: 90% → Full Secretary
Multi-user system built and merged. 189 tests passing across 27 files. Email, calendar, briefings, dev request queue all user-scoped. Main gaps: business communication drafting, meeting prep, proactive scheduling, Railway persistent volume.

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
