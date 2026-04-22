/**
 * Parser + user resolver for `/briefing-preview [--user=<name>]`.
 *
 * Kept as pure functions so the logic is unit-testable without having to
 * import `src/index.ts` (which pulls in config + the Anthropic SDK).
 */

import type Database from 'better-sqlite3';
import { getAllUsers, type User } from '../db/user-queries.js';

export interface ParsedBriefingPreviewCommand {
  matched: boolean;
  /** The raw name from --user=<name> (case preserved). Undefined when absent. */
  targetName?: string;
}

/**
 * Parse a raw Telegram text into a structured `/briefing-preview` command.
 * Returns `{ matched: false }` for anything that isn't the bare command or
 * the `--user=<name>` form. The command prefix match is case-insensitive;
 * the target name is returned with its original casing for the display
 * string when we fall through to findUserByFirstName (which folds case).
 */
export function parseBriefingPreviewCommand(raw: string): ParsedBriefingPreviewCommand {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { matched: false };

  // Bare command.
  if (/^\/briefing-preview$/i.test(trimmed)) {
    return { matched: true };
  }

  // --user=<name> form. Tolerates extra whitespace but requires the flag to
  // start with `--user=` followed by a non-empty value.
  const flagMatch = trimmed.match(/^\/briefing-preview\s+--user=(\S+)$/i);
  if (flagMatch && flagMatch[1] && flagMatch[1].length > 0) {
    return { matched: true, targetName: flagMatch[1] };
  }

  return { matched: false };
}

/**
 * Case-insensitive first-name lookup on `users.name`. "First name" = the
 * first whitespace-separated token of the stored name. Used by the
 * `/briefing-preview --user=<name>` admin command.
 *
 * Returns undefined when no user matches. Returns the first match when more
 * than one user shares a first name — callers can escalate on ambiguity if
 * that ever becomes real (today the roster is small enough for first-name
 * lookup to be unambiguous).
 */
export function findUserByFirstName(db: Database.Database, name: string): User | undefined {
  const target = name.trim().toLowerCase();
  if (!target) return undefined;
  const users = getAllUsers(db);
  return users.find((u) => {
    const first = (u.name ?? '').trim().split(/\s+/)[0] ?? '';
    return first.toLowerCase() === target;
  });
}
