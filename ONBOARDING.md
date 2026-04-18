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
