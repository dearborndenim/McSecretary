/**
 * Parser for the admin `/briefing-sections` command.
 *
 * Originally shipped 2026-04-22 with two forms:
 *   /briefing-sections --user=<name> --set=<csv>
 *   /briefing-sections --user=<name> --reset
 *
 * Polish 2026-04-23 added a read/list form:
 *   /briefing-sections --list                  → canonical section catalog
 *   /briefing-sections --user=<name> --list    → that user's saved pref (or default)
 *
 * Parser is pure — it does NOT validate section names against
 * VALID_BRIEFING_SECTIONS (that happens in the handler after the parser
 * result is known, so we can emit a helpful "invalid section(s)" error
 * alongside the same valid-list error the preview command uses).
 */

export interface ParsedBriefingSectionsCommand {
  matched: boolean;
  /**
   * Target user first name. Required for --set / --reset; optional for --list
   * (when --list is bare it shows the canonical catalog of valid section
   * names instead of any user-specific value).
   */
  targetName?: string;
  /**
   * Raw comma-separated value from `--set=<csv>`. Present only when the
   * `--set=` form matched. Mutually exclusive with `reset` and `list`.
   */
  setRaw?: string;
  /** True when the `--reset` flag was present. Mutually exclusive with `setRaw` / `list`. */
  reset?: boolean;
  /** True when the `--list` flag was present. Mutually exclusive with `setRaw` / `reset`. */
  list?: boolean;
}

export function parseBriefingSectionsCommand(raw: string): ParsedBriefingSectionsCommand {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { matched: false };

  const prefixMatch = trimmed.match(/^\/briefing-sections(?:\s+(.*))?$/i);
  if (!prefixMatch) return { matched: false };

  const rest = (prefixMatch[1] ?? '').trim();
  // The bare command (no args) is rejected — admin must specify a user and
  // either --set, --reset, or --list. Unlike /briefing-preview, bare here
  // has no natural semantics.
  if (rest.length === 0) return { matched: false };

  const tokens = rest.split(/\s+/);
  let targetName: string | undefined;
  let setRaw: string | undefined;
  let reset = false;
  let list = false;

  for (const token of tokens) {
    const userMatch = token.match(/^--user=(.+)$/i);
    if (userMatch && userMatch[1] && userMatch[1].length > 0) {
      if (targetName !== undefined) return { matched: false };
      targetName = userMatch[1];
      continue;
    }
    const setMatch = token.match(/^--set=(.+)$/i);
    if (setMatch && setMatch[1] && setMatch[1].length > 0) {
      if (setRaw !== undefined || reset || list) return { matched: false };
      setRaw = setMatch[1];
      continue;
    }
    if (/^--reset$/i.test(token)) {
      if (reset || setRaw !== undefined || list) return { matched: false };
      reset = true;
      continue;
    }
    if (/^--list$/i.test(token)) {
      if (list || setRaw !== undefined || reset) return { matched: false };
      list = true;
      continue;
    }
    return { matched: false };
  }

  // --list may appear bare (no --user) OR with --user. --set / --reset still
  // require --user. Exactly one of set / reset / list must be present.
  const actionCount = (setRaw !== undefined ? 1 : 0) + (reset ? 1 : 0) + (list ? 1 : 0);
  if (actionCount !== 1) return { matched: false };
  if (!list && !targetName) return { matched: false };

  return {
    matched: true,
    targetName,
    setRaw,
    reset: reset || undefined,
    list: list || undefined,
  };
}
