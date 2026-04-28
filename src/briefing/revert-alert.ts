/**
 * Per-user "section preferences changed" alert (Polish 5, 2026-04-27).
 *
 * If a user has more than `BRIEFING_REVERT_ALERT_THRESHOLD` revert audit rows
 * within the trailing 24h, fire a warning alert. Alert delivery is pluggable
 * — by default the alert is logged to console and (when a `sendMessage`
 * function is supplied by the caller) broadcast via Telegram. A 12h per-user
 * cooldown prevents alert spam.
 *
 * Opt-out via `DISABLE_BRIEFING_REVERT_ALERT=1`.
 *
 * The threshold default (3) reflects the assumption that any single user
 * reverting more than three times a day is signal-worthy: either an admin
 * is iterating noisily on prefs, or the user is actively disagreeing with a
 * recent change.
 */
import type Database from 'better-sqlite3';
import { getBriefingSectionsAuditForUserSince } from '../db/user-queries.js';

export interface RevertAlertDeps {
  /** Overridable now() for tests; defaults to `new Date()`. */
  now?: () => Date;
  /** Overridable env reader; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /**
   * Optional Telegram sender. When supplied AND an alert fires, the alert
   * message is broadcast via Telegram in addition to the console log.
   * Failures are swallowed — alerting must never break the parent action.
   */
  sendMessage?: (text: string) => Promise<void> | void;
  /**
   * Optional console-like log surface. Defaults to `console`. Tests inject
   * a fake to assert what was logged.
   */
  console?: { log: (...args: unknown[]) => void; error: (...args: unknown[]) => void };
}

export interface RevertAlertResult {
  fired: boolean;
  /** Number of revert rows in the trailing 24h window for this user. */
  count: number;
  /** Threshold used (env override or default). */
  threshold: number;
  /** Friendly reason when not fired. */
  reason?: 'disabled' | 'below_threshold' | 'cooldown' | 'fired';
  /** The rendered alert message (when fired) or null. */
  message: string | null;
}

/**
 * In-memory per-user cooldown stamp (epoch ms of last fire). Resets on
 * process restart — by design, since alerts are per-process and the
 * cooldown protects against a tight loop of reverts within a single
 * session, not across deploys.
 */
const lastFiredAt = new Map<string, number>();

const COOLDOWN_MS = 12 * 60 * 60 * 1000; // 12h

/** Test-only — clear the in-memory cooldown map so suites don't leak state. */
export function _resetRevertAlertCooldownForTesting(): void {
  lastFiredAt.clear();
}

function resolveThreshold(env: Record<string, string | undefined>): number {
  const raw = env.BRIEFING_REVERT_ALERT_THRESHOLD;
  const fallback = 3;
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

/**
 * Inspect the audit log and fire a warning alert when the per-user revert
 * count in the last 24h exceeds the configured threshold.
 *
 * Returns a `RevertAlertResult` that callers can log. Non-throwing — any
 * delivery failure is swallowed (logged via deps.console.error).
 */
export async function maybeFireRevertAlert(
  db: Database.Database,
  userName: string,
  deps: RevertAlertDeps = {},
): Promise<RevertAlertResult> {
  const env = deps.env ?? (process.env as Record<string, string | undefined>);
  const log = deps.console ?? console;

  if (env.DISABLE_BRIEFING_REVERT_ALERT === '1') {
    return { fired: false, count: 0, threshold: 0, reason: 'disabled', message: null };
  }

  const threshold = resolveThreshold(env);
  const now = deps.now ? deps.now() : new Date();
  const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  let allRows: { action: string }[] = [];
  try {
    allRows = getBriefingSectionsAuditForUserSince(db, userName, cutoff);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`maybeFireRevertAlert: audit read failed for ${userName}: ${msg}`);
    return {
      fired: false,
      count: 0,
      threshold,
      reason: 'below_threshold',
      message: null,
    };
  }
  const count = allRows.filter((r) => r.action === 'revert').length;

  if (count <= threshold) {
    return { fired: false, count, threshold, reason: 'below_threshold', message: null };
  }

  // Threshold exceeded — check the per-user cooldown.
  const cooldownKey = userName.trim().toLowerCase();
  const last = lastFiredAt.get(cooldownKey);
  if (last !== undefined && now.getTime() - last < COOLDOWN_MS) {
    return { fired: false, count, threshold, reason: 'cooldown', message: null };
  }

  const message =
    `[Briefing-sections alert] User '${userName}' has reverted briefing prefs ${count} times in the last 24h ` +
    `(threshold ${threshold}). Investigate.`;

  // Stamp the cooldown BEFORE delivery so a slow/throwing transport doesn't
  // double-fire if the caller retries.
  lastFiredAt.set(cooldownKey, now.getTime());

  try {
    log.log(message);
  } catch {
    /* swallow */
  }
  if (deps.sendMessage) {
    try {
      await deps.sendMessage(message);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`maybeFireRevertAlert: telegram send failed: ${msg}`);
    }
  }

  return { fired: true, count, threshold, reason: 'fired', message };
}
