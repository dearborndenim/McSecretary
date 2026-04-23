/**
 * Parser + user resolver for `/briefing-preview [--user=<name>] [--sections=<csv>]`.
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
  /**
   * Raw comma-separated value from `--sections=<csv>` (unvalidated; caller
   * passes it to parseSectionList for validation). Undefined when absent.
   */
  sectionsRaw?: string;
}

/**
 * Parse a raw Telegram text into a structured `/briefing-preview` command.
 * Returns `{ matched: false }` for anything that isn't the bare command or a
 * supported flag combination. The command prefix match is case-insensitive;
 * flag values are returned with their original casing so downstream resolvers
 * can fold case as needed.
 *
 * Supported forms:
 *   /briefing-preview
 *   /briefing-preview --user=<name>
 *   /briefing-preview --sections=<csv>
 *   /briefing-preview --user=<name> --sections=<csv>
 *   /briefing-preview --sections=<csv> --user=<name>
 */
export function parseBriefingPreviewCommand(raw: string): ParsedBriefingPreviewCommand {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { matched: false };

  // Must start with the command (case-insensitive); anything after is optional flags.
  const prefixMatch = trimmed.match(/^\/briefing-preview(?:\s+(.*))?$/i);
  if (!prefixMatch) return { matched: false };

  const rest = (prefixMatch[1] ?? '').trim();
  if (rest.length === 0) {
    return { matched: true };
  }

  // Tokenize on whitespace and require every token to be a recognized flag.
  // Order-independent; each flag may appear at most once.
  const tokens = rest.split(/\s+/);
  let targetName: string | undefined;
  let sectionsRaw: string | undefined;

  for (const token of tokens) {
    const userMatch = token.match(/^--user=(.+)$/i);
    if (userMatch && userMatch[1] && userMatch[1].length > 0) {
      if (targetName !== undefined) return { matched: false }; // duplicate flag
      targetName = userMatch[1];
      continue;
    }
    const sectionsMatch = token.match(/^--sections=(.+)$/i);
    if (sectionsMatch && sectionsMatch[1] && sectionsMatch[1].length > 0) {
      if (sectionsRaw !== undefined) return { matched: false }; // duplicate flag
      sectionsRaw = sectionsMatch[1];
      continue;
    }
    // Unknown token → reject (keeps parser strict so typos don't silently pass).
    return { matched: false };
  }

  return {
    matched: true,
    targetName,
    sectionsRaw,
  };
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
