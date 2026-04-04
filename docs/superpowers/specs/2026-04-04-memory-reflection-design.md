# Conversation Memory + Daily Reflection System — Design Spec

**Date:** 2026-04-04

---

## Goal

Give McSecretary persistent memory within each day (conversation continuity) and a self-improvement cycle (daily reflection, learnings, improvement plans) that accumulates into master knowledge files synthesized weekly.

## Architecture

Two subsystems:

1. **Conversation Memory** — SQLite table stores all messages exchanged via Telegram. Each API call loads today's full conversation history + daily context, giving the secretary continuous awareness throughout the day.

2. **Journal/Reflection System** — End-of-day scheduled task where the secretary reflects on its performance, writes learnings about Rob and the businesses, plans improvements for tomorrow, and prompts Rob to journal. Weekly synthesis consolidates daily files into master knowledge files.

## Conversation Memory

### conversation_log table

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment |
| date | TEXT | YYYY-MM-DD (Chicago time) |
| timestamp | TEXT | Full ISO timestamp |
| role | TEXT | `rob` or `secretary` |
| message | TEXT | Full message text |

### Message handler flow

1. Rob sends message via Telegram
2. Load today's conversation history from `conversation_log`
3. Load daily context (see below)
4. Build Claude API call with: system prompt + daily context + conversation history + new message
5. Get response
6. Store both Rob's message and secretary's response in `conversation_log`
7. Send response via Telegram

### Daily context (loaded into system prompt each message)

- `data/journal/secretary/master-learnings.md` — accumulated knowledge about Rob and businesses
- `data/journal/secretary/master-patterns.md` — behavioral patterns ("when Rob says X, he means Y")
- Yesterday's `improvements.md` — what to do better today
- Yesterday's `reflection.md` — what happened yesterday (brief reference)

### Context window management

If today's conversation exceeds 50 messages, keep only the last 30 messages plus a summary of earlier messages. This prevents context window overflow during heavy-use days.

## Journal/Reflection System

### File structure

```
data/journal/
├── secretary/
│   ├── master-learnings.md       (synthesized weekly, loaded daily)
│   ├── master-patterns.md        (synthesized weekly, loaded daily)
│   ├── 2026-04-04-reflection.md  (daily, raw)
│   ├── 2026-04-04-improvements.md (daily, loaded next morning)
│   └── 2026-04-04-learnings.md   (daily, raw, consumed by weekly synthesis)
└── rob/
    └── 2026-04-04.md             (Rob's journal, if he responds to prompt)
```

### End-of-day sequence (4 PM scheduled task)

1. **Prompt Rob to journal** — send Telegram message: "End of day. How was your day? Anything you want to reflect on?" Store response if Rob replies within the same evening.

2. **Generate secretary reflection** — read today's full conversation log + time logs + email activity. Write `YYYY-MM-DD-reflection.md`:
   - What I did today (summary of conversations, actions taken)
   - What I did well (accurate answers, proactive help, good suggestions)
   - What I did poorly (wrong answers, missed context, unhelpful responses, times Rob corrected me)
   - Key interactions (notable conversations or decisions)

3. **Generate improvement plan** — based on reflection, write `YYYY-MM-DD-improvements.md`:
   - Specific behavioral changes for tomorrow
   - Corrections to apply (e.g., "Rob uses 'new customer' to mean Apollo prospecting responses")
   - Things to watch for

4. **Generate learnings** — write `YYYY-MM-DD-learnings.md`:
   - New facts about Rob (preferences, habits, schedule)
   - New facts about the businesses (contacts, processes, tools, terminology)
   - New facts about relationships (who works with whom, communication preferences)

5. **Store Rob's journal** — if Rob responded to the reflection prompt, write `rob/YYYY-MM-DD.md`

### Morning context compilation (4 AM, before briefing)

Before generating the morning briefing, compile today's context:
1. Read `master-learnings.md` and `master-patterns.md`
2. Read yesterday's `improvements.md` and `reflection.md`
3. These become part of the system prompt for all interactions today

### Weekly synthesis (Sunday 7 PM)

1. Read all daily learnings files from the past week
2. Read current `master-learnings.md` and `master-patterns.md`
3. Use Claude to synthesize: merge new learnings into master files, deduplicate, update anything that changed, remove anything that's no longer accurate
4. Write updated master files
5. Daily files become archive (not deleted, but no longer loaded)

### Master file format

**master-learnings.md:**
```markdown
# What I Know About Rob and the Businesses
Last updated: 2026-04-04

## Rob
- Works Monday-Friday, 6 AM - 4 PM Central
- Bikes to work when weather is nice (50 min commute)
- Gym mornings otherwise
- Has wife and kids, values family time after 4 PM
...

## Dearborn Denim
- Denim/jeans company, retail + wholesale
- rob@dearborndenim.com
...

## McMillan Manufacturing
- Contract manufacturing
- robert@mcmillan-manufacturing.com
- Uses Apollo for cold outreach prospecting
- Merab handles shipping
- Uses Gemini software for pattern management
...

## Key Contacts
- Thomas NASSCO — prospecting response, potential customer
- Pacific Fabrics — fabric supplier
...
```

**master-patterns.md:**
```markdown
# How to Work With Rob
Last updated: 2026-04-04

## Communication
- Be direct, no hedging
- No emoji
- Don't ask the same question twice
- When Rob says "new customer emails" he means Apollo prospecting responses
...

## Email Handling
- "Check my email" = fetch and summarize recent emails, don't run full triage
- Unread emails from unknown senders to McMillan Mfg = likely prospecting responses
...

## Common Corrections
- [date] Rob corrected: "new customers" means Apollo outreach responses, not general inquiries
...
```

## What This Does NOT Include

- Project management / Microsoft To Do integration (separate phase)
- iMessage reading (separate phase)
- File management (separate phase)
- Proactive suggestions beyond the reflection system (separate phase)
