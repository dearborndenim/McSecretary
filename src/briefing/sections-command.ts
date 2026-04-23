/**
 * Parser for the admin `/briefing-sections` command (Task 7, 2026-04-22).
 *
 * Supported forms:
 *   /briefing-sections --user=<name> --set=<csv>
 *   /briefing-sections --user=<name> --reset
 *
 * Parser is pure — it does NOT validate section names against
 * VALID_BRIEFING_SECTIONS (that happens in the handler after the parser
 * result is known, so we can emit a helpful "invalid section(s)" error
 * alongside the same valid-list error the preview command uses).
 */

export interface ParsedBriefingSectionsCommand {
  matched: boolean;
  /** Target user first name. Always required (even for --reset). */
  targetName?: string;
  /**
   * Raw comma-separated value from `--set=<csv>`. Present only when the
   * `--set=` form matched. Mutually exclusive with `reset`.
   */
  setRaw?: string;
  /** True when the `--reset` flag was present. Mutually exclusive with `setRaw`. */
  reset?: boolean;
}

export function parseBriefingSectionsCommand(raw: string): ParsedBriefingSectionsCommand {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { matched: false };

  const prefixMatch = trimmed.match(/^\/briefing-sections(?:\s+(.*))?$/i);
  if (!prefixMatch) return { matched: false };

  const rest = (prefixMatch[1] ?? '').trim();
  // The bare command (no args) is rejected — admin must specify a user and
  // either --set or --reset. Unlike /briefing-preview, bare here has no
  // natural semantics.
  if (rest.length === 0) return { matched: false };

  const tokens = rest.split(/\s+/);
  let targetName: string | undefined;
  let setRaw: string | undefined;
  let reset = false;

  for (const token of tokens) {
    const userMatch = token.match(/^--user=(.+)$/i);
    if (userMatch && userMatch[1] && userMatch[1].length > 0) {
      if (targetName !== undefined) return { matched: false };
      targetName = userMatch[1];
      continue;
    }
    const setMatch = token.match(/^--set=(.+)$/i);
    if (setMatch && setMatch[1] && setMatch[1].length > 0) {
      if (setRaw !== undefined || reset) return { matched: false };
      setRaw = setMatch[1];
      continue;
    }
    if (/^--reset$/i.test(token)) {
      if (reset || setRaw !== undefined) return { matched: false };
      reset = true;
      continue;
    }
    return { matched: false };
  }

  // Must have target + exactly one of set/reset.
  if (!targetName) return { matched: false };
  if (!reset && setRaw === undefined) return { matched: false };

  return {
    matched: true,
    targetName,
    setRaw,
    reset: reset || undefined,
  };
}
