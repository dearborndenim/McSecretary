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
