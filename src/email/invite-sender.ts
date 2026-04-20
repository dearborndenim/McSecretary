/**
 * Invite email delivery.
 *
 * Purpose: send a team member their one-shot `/start <code>` invite over email
 * so the admin doesn't have to relay codes manually out-of-band.
 *
 * Transport strategy:
 * - Preferred: Microsoft Graph `sendMail` from the configured admin mailbox
 *   (reuses the same Azure AD client credentials McSecretary already uses
 *   for reading email). This requires `INVITE_SENDER_EMAIL` to be set and a
 *   usable `getGraphToken()`.
 * - Fallback: when `INVITE_SENDER_EMAIL` is not set (e.g. local dev, CI, or
 *   no admin mailbox configured yet) or when `SMTP_HOST` is explicitly unset,
 *   the function logs the invite to stdout and returns `{ ok: true, transport:
 *   'stdout' }`. This is the "stub" contract promised to callers so the
 *   `/onboard-all-pending` flow never fails hard on email delivery.
 *
 * Callers should treat a `transport: 'stdout'` result as a non-fatal
 * "not-yet-wired" — the invite code is still valid, it just wasn't emailed.
 *
 * All errors are caught and surfaced as `{ ok: false, error: message }` so
 * the bulk onboarding handler can collect per-recipient outcomes without
 * aborting the batch.
 */

export interface SendInviteEmailInput {
  to: string;
  name: string;
  code: string;
  /**
   * Optional subject prefix. The 48h reminder job passes `"Reminder: "` so the
   * re-sent invite is distinguishable in the inbox from the original.
   */
  subjectPrefix?: string;
}

export interface SendInviteEmailResult {
  ok: boolean;
  transport: 'graph' | 'stdout';
  error?: string;
}

export interface SendInviteEmailDeps {
  /** Overridable Graph token fetcher — main hook point for tests. */
  getGraphToken?: () => Promise<string>;
  /** Overridable fetch implementation — lets tests mock Graph HTTP. */
  fetchImpl?: typeof fetch;
  /** Overridable logger for the stdout fallback. Defaults to console.log. */
  logger?: (line: string) => void;
  /** Overridable env reader — lets tests flip SMTP_HOST / INVITE_SENDER_EMAIL. */
  env?: Record<string, string | undefined>;
}

/**
 * Build the plain-text body delivered to invitees. Kept as a pure function so
 * tests can assert the exact contents without re-sending.
 */
export function buildInviteBody(name: string, code: string, botHandle: string): string {
  return [
    `Hi ${name},`,
    '',
    "You've been invited to McSecretary, Dearborn Denim's AI secretary.",
    '',
    'To link your Telegram account, open the bot and send:',
    '',
    `    /start ${code}`,
    '',
    `Bot handle: ${botHandle}`,
    '',
    'Schedule window (team members): 6 AM – 2:30 PM CT.',
    '  - Hourly check-ins every hour from 6 AM through 2 PM.',
    '  - End-of-day reflection at 2:30 PM.',
    '  - Admins override per-user with set-preferences if needed.',
    '',
    `Your invite code expires in 7 days. If it expires, ask Robert to re-issue via /invite ${'<'}your-email${'>'}.`,
    '',
    '— McSecretary',
  ].join('\n');
}

/**
 * Send an invite email to one recipient.
 *
 * Returns a structured result rather than throwing — the caller (bulk
 * onboarding handler) needs to collect successes and failures into a single
 * summary message.
 */
export async function sendInviteEmail(
  input: SendInviteEmailInput,
  deps: SendInviteEmailDeps = {},
): Promise<SendInviteEmailResult> {
  const env = deps.env ?? (process.env as Record<string, string | undefined>);
  const logger = deps.logger ?? ((line: string) => console.log(line));
  const sender = env.INVITE_SENDER_EMAIL ?? '';
  const botHandle = env.TELEGRAM_BOT_HANDLE ?? '@mcsecretary_bot';
  const body = buildInviteBody(input.name, input.code, botHandle);
  const prefix = input.subjectPrefix ?? '';
  const subject = `${prefix}Your McSecretary invite code: ${input.code}`;

  // Stdout fallback: intentional stub when the admin mailbox isn't configured
  // (e.g. SMTP_HOST unset in local dev, or INVITE_SENDER_EMAIL blank).
  if (!sender || env.SMTP_HOST === '') {
    logger(
      [
        `[invite-email:stdout] to=${input.to} subject="${subject}"`,
        body,
        `[invite-email:stdout:end]`,
      ].join('\n'),
    );
    return { ok: true, transport: 'stdout' };
  }

  // Graph-backed delivery reuses the same MSAL client-credentials flow the
  // rest of McSecretary uses for reading Outlook mailboxes.
  try {
    const getToken =
      deps.getGraphToken ??
      (async () => {
        const mod = await import('../auth/graph.js');
        return mod.getGraphToken();
      });
    const fetchImpl = deps.fetchImpl ?? fetch;
    const token = await getToken();
    const res = await fetchImpl(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sender)}/sendMail`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: {
            subject,
            body: { contentType: 'text', content: body },
            toRecipients: [{ emailAddress: { address: input.to } }],
          },
          saveToSentItems: true,
        }),
      },
    );

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return {
        ok: false,
        transport: 'graph',
        error: `Graph sendMail failed: ${res.status} ${res.statusText} ${text}`,
      };
    }
    return { ok: true, transport: 'graph' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, transport: 'graph', error: msg };
  }
}
