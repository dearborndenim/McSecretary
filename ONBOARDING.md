# McSecretary — User Onboarding Playbook

The `/start <code>` flow links a Telegram chat to a pre-created user row.
This document captures the exact sequence admins and invitees follow.

## Who does what

Two roles participate:

- **Admin** — typically Robert. Creates the user record via the admin CLI or
  `/invite` DM, then relays the invite code to the invitee.
- **Invitee** — the new team member. Sends `/start <code>` to the bot from
  the Telegram account that will receive their briefings.

## Step-by-step

### 1. Admin: create the user (CLI path)

```bash
npx tsx src/admin.ts add-user \
  --name "Olivier" \
  --email "olivier@dearborndenim.com" \
  --role member
```

This emits the invite code on stdout. The code is 8 chars, lives in
`user_invites`, and expires after 7 days by default.

### 2. Admin: create the user (Telegram path)

Admin DMs the bot:

```
/invite olivier@dearborndenim.com
```

The bot responds with an invite code. If the user already exists the bot
generates a fresh code for the existing row (idempotent).

### 3. Admin: relay the code to the invitee

Manually — Slack, SMS, email, however is convenient. The bot does not
deliver codes on the invitee's behalf. This is deliberate: we want the
admin to confirm the invitee's Telegram account before linkage.

### 3a. Bulk onboarding via `/onboard-all-pending` (admin-only)

When onboarding more than one invitee at a time, the admin can drop a
manifest at the repo root and run a single Telegram command instead of
repeating `/invite` per person.

**Manifest** — `pending_invites.json` at the repo root:

```json
[
  { "email": "olivier@dearborndenim.com", "name": "Olivier" },
  { "email": "merab@dearborndenim.com",   "name": "Merab" }
]
```

Schema:

| Field              | Required | Notes                                                                          |
|--------------------|----------|--------------------------------------------------------------------------------|
| `email`            | yes      | Must match a row in `users.email`                                              |
| `name`             | yes      | Used in the email body greeting                                                |
| `role`             | no       | `"admin"` or `"staff"`. Defaults to `"staff"` for backward compatibility.      |
| `invited_at`       | no       | ISO timestamp stamped by `/onboard-all-pending` on delivery                    |
| `started_at`       | no       | ISO timestamp stamped by `/start <code>` when invitee links their Telegram     |
| `reminder_sent_at` | no       | ISO timestamp stamped by the 48h reminder job (prevents re-sends)              |
| `onboarded_at`     | no       | ISO timestamp. Written by McSecretary on successful initial invite delivery    |

**Command** — admin DMs the bot:

```
/onboard-all-pending
```

For each entry with no `onboarded_at`:

1. Look up the user row by email (must already exist — run `seedTeam` or
   `admin.ts add-user` first).
2. Mint a fresh invite code via `createInvite(db, userId)`.
3. Email the code via `sendInviteEmail` — uses Microsoft Graph
   `sendMail` from the mailbox named in `INVITE_SENDER_EMAIL`. If that
   env var is unset, falls back to stdout log (safe for local dev).
4. Stamp `onboarded_at = <iso>` on the entry so re-running is idempotent.

**Reply** — Telegram summary per invitee with totals, e.g.:

```
Bulk onboarding summary:

✓ Olivier — emailed code abc12345
✗ Merab — no user row for merab@dearborndenim.com

Totals: sent=1 stubbed=0 skipped=0 failed=1
```

**Env vars** for the email path:

| Var                     | Effect                                                                   |
|-------------------------|--------------------------------------------------------------------------|
| `INVITE_SENDER_EMAIL`   | Mailbox sending invites. Unset → stdout stub only.                       |
| `TELEGRAM_BOT_HANDLE`   | Bot handle referenced in the email body. Defaults to `@mcsecretary_bot`. |
| `SMTP_HOST=""`          | Explicit opt-out — forces stdout stub even when sender is configured.     |

**Failure modes:**

- `user_not_found` — manifest email has no matching row. Fix by seeding
  the user first, then re-run (entry is NOT marked onboarded).
- `email_failed` — Graph returned non-2xx or network error. The invite
  code is still minted in the DB, but the entry is NOT marked onboarded
  so the admin can re-run after fixing the mail path.
- `already_onboarded` — previous run stamped `onboarded_at`. Skipped.

### 3b. Admin: `/onboarding-status` to see who's pending vs linked

At any time the admin can DM:

```
/onboarding-status
```

The bot replies with a single message listing up to 20 pending entries
(no `onboarded_at`) and up to 20 onboarded entries (most recent first).
Older entries are summarized as `…and N older truncated` so the message
always fits in a single Telegram reply.

### 3c. Daily 48h reminder job

Scheduled once daily at 9 AM CT. Iterates `pending_invites.json` and,
for each entry where:

- `invited_at` is >48 hours old,
- `started_at` is unset (invitee hasn't linked yet),
- `reminder_sent_at` is unset (no prior reminder),

it mints a fresh invite code and re-sends the invite email with
`"Reminder: "` prefixed to the subject line, then stamps
`reminder_sent_at`. Entries that are already linked (`started_at`
present) or already reminded are skipped.

### 4. Invitee: `/start <code>` from Telegram

The invitee opens the bot in Telegram and sends:

```
/start a1b2c3d4
```

The bot does the following, atomically:

1. Looks up the code in `user_invites` (must be unused and unexpired).
2. Marks the invite `used_at = now()`.
3. Writes `users.telegram_chat_id = <invitee chat_id>`.
4. Replies `Welcome, <name>! You're linked.`

If the code is invalid, expired, or already consumed, the bot replies
`Invalid or expired invite code.` and makes no DB writes beyond the
lookup.

### 5. Schedule windows are backfilled on first read

The user's `check_in_cron` and `eod_cron` columns stay `NULL` after
`/start`. `getUserScheduleWindows()` returns role-based defaults when
the columns are null:

| Role   | check_in_cron          | eod_cron           |
|--------|------------------------|--------------------|
| admin  | `0 6-19 * * 1-5`       | `0 19 * * 1-5`     |
| member | `0 6-14 * * 1-5`       | `30 14 * * 1-5`    |
| staff  | `0 7-13 * * 1-5`       | `30 13 * * 1-5`    |

Staff bounds are configurable via `STAFF_SCHEDULE_WINDOW_START` /
`STAFF_SCHEDULE_WINDOW_END` env vars (integer hours 0–23).

Members thus get 6 AM – 2 PM CT hourly check-ins and a 2:30 PM CT EOD
summary. Admins get 6 AM – 7 PM CT check-ins and a 7 PM CT EOD. Admins
can override per-user via `npx tsx src/admin.ts set-preferences`.

### 6. First briefing fires at the next scheduled window

The scheduler runs on a union cron (every 30 min weekdays). Each tick
enumerates active users and compares the current time against each
user's `check_in_cron` / `eod_cron`; matching users receive the briefing.
First briefing for a freshly-linked user is the next hour on the half.

## Permission roles

Roles are fixed at user-creation time and carried through `/start`.

- `admin` — can run `/invite`, `/review`, `/approve`, `/reject`, `status`,
  and `feedback` in Telegram.
- `member` — restricted to `/request`, `/myrequests`, `briefing`,
  `journal:`, `/log`, and `status`.

`/start` does **not** change roles; if the invitee needs admin access
the admin must `UPDATE users SET role='admin'` (no CLI command yet).

## Failure modes and recovery

- **Invitee sends `/start` without a code** — bot replies `Usage: /start
  <invite_code>`.
- **Invitee sends unknown code** — bot replies `Invalid or expired
  invite code.` and does not write anything. Admin can re-issue with
  `npx tsx src/admin.ts generate-invite --user-id X`.
- **Invitee sends code that was already consumed** — same error. Re-issue
  a new code.
- **Invitee's chat_id changes (new phone / new Telegram account)** — admin
  runs `generate-invite` again; the user redeems it and the new chat_id
  overwrites the old one via `linkTelegramChat`.

## Reference

- `src/index.ts` — /start handler (~line 1018)
- `src/db/user-queries.ts` — `createInvite`, `consumeInvite`,
  `linkTelegramChat`, `getUserScheduleWindows`
- `tests/multi-user/start-flow-e2e.test.ts` — end-to-end integration test
  covering member defaults, admin defaults, expired code, single-use
  enforcement, and invalid code rejection.
