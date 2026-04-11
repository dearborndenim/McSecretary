# McSecretary — Project Status

## Vision
Full AI secretary for Robert. Autonomous email management across 3 accounts (2 Outlook, 1 Gmail), daily briefings, calendar management, task tracking, time management, journaling/reflection, and eventually: agent empire coordination (route feedback to projects, compile overnight build reports, be the human-AI communication layer).

## Current Reality (last updated: 2026-04-10)
- **Deployment:** Railway (cron job)
- **GitHub:** github.com/dearborndenim/McSecretary — last commit Apr 6: "fix: email scan tags silently"
- **Communication:** Telegram bot for notifications and interaction with Robert
- **Email - Outlook (2 accounts):** Working — fetch, classify (Haiku), archive, categorize, bulk operations, send
- **Email - Gmail:** IMPLEMENTED (2026-04-10). OAuth2 token refresh flow (`src/auth/google.ts`), Gmail email fetcher (`src/email/gmail.ts`), wired into triage pipeline and interactive context. Uses native fetch, no extra deps. Needs: GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN env vars set in Railway. Optional — gracefully skipped if not configured. Still needs: `src/briefing/sender.ts` for sending briefings via Gmail.
- **Email Classification:** Working — Haiku classifies spam/not-spam, auto-tags silently
- **Email Scanning:** Working — auto-scans every 30 min, bulk-tags via Graph batch API
- **Morning Briefing:** Working — Sonnet generates briefing, sent via Telegram
- **Calendar:** Working — list, create, update, delete events (Outlook calendar)
- **Tasks/To-Do:** Working — Microsoft To Do integration (create, complete, list, track completions)
- **Task Polling:** Working — every 15 min, detects completed tasks, logs as time
- **Time Tracking:** Working — logs time from task completions and check-ins
- **Journaling:** Working — end-of-day reflection, weekly synthesis
- **Scheduler:** Working — configurable schedule for briefing, check-ins, evening summary, weekly synthesis
- **Tools for Claude:** 20+ tools (archive, categorize, bulk ops, calendar, tasks, schedule management)
- **Contacts:** Working — read contacts from Outlook

## What's Missing for Full Secretary
- **Gmail integration:** Fetch + auth BUILT (2026-04-10). Still needs: `src/briefing/sender.ts` for sending briefings via Gmail, and Gmail OAuth2 credentials configured in Railway env vars.
- **Agent Empire coordination:** Route dispatch feedback to PROJECT_STATUS.md files across projects (DONE in feature/empire-coordination)
- **Overnight build reporting:** DONE in feature/briefing-gmail — triage.ts now fetches NIGHTLY_PLAN.md from claude_code repo via GitHub API and passes it to the briefing generator as an "Overnight Dev" section. Graceful failure if GitHub token missing.
- **Business communications drafting:** Draft professional emails, customer responses
- **Meeting prep:** Prep notes for upcoming meetings from calendar + related emails
- **Document management:** Interface with SharePoint/OneDrive for filing
- **Proactive scheduling:** Suggest time blocks based on priorities and deadlines
- **Multi-brand support:** When new brands launch, secretary needs to manage comms for all brands

## Robert's Feedback
- 2026-04-10: "My secretary still needs to finish the full buildout"

## Iteration Backlog
1. Set Gmail OAuth2 env vars in Railway + verify 3-account fetch is working
2. Add agent empire coordination — route feedback from dispatch to PROJECT_STATUS.md files
3. Integrate overnight build reporting into morning briefing
4. Add meeting prep notes (pull relevant emails + docs before calendar events)
5. Add business communication drafting capability
6. Add proactive scheduling suggestions
7. Test and harden all 20+ tools for reliability

## Maturity: 65% → Full Secretary
Strong foundation with email, calendar, tasks, time tracking, and journaling all working. Main gaps: Gmail unclear, no agent empire coordination, no overnight build reporting integration, missing proactive features.
