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
 * Polish 2026-04-24 added two more forms:
 *   /briefing-sections --user=<name> --diff      → user's pref vs full briefing
 *   /briefing-sections --set-all=<csv> --apply-to=all → bulk-set all onboarded users
 *
 * Parser is pure — it does NOT validate section names against
 * VALID_BRIEFING_SECTIONS (that happens in the handler after the parser
 * result is known, so we can emit a helpful "invalid section(s)" error
 * alongside the same valid-list error the preview command uses).
 */

export interface ParsedBriefingSectionsCommand {
  matched: boolean;
  /**
   * Target user first name. Required for --set / --reset / --diff; optional
   * for --list (when --list is bare it shows the canonical catalog of valid
   * section names instead of any user-specific value). Not used by --set-all.
   */
  targetName?: string;
  /**
   * Raw comma-separated value from `--set=<csv>`. Present only when the
   * `--set=` form matched. Mutually exclusive with `reset` / `list` / `diff` /
   * `setAllRaw`.
   */
  setRaw?: string;
  /** True when the `--reset` flag was present. Mutually exclusive with siblings. */
  reset?: boolean;
  /** True when the `--list` flag was present. Mutually exclusive with siblings. */
  list?: boolean;
  /** True when the `--diff` flag was present. Mutually exclusive with siblings. */
  diff?: boolean;
  /**
   * Raw comma-separated value from `--set-all=<csv>`. Present only when the
   * `--set-all=` form matched. Must be paired with `applyTo === 'all'`.
   */
  setAllRaw?: string;
  /** Value of the `--apply-to=<scope>` flag. Currently must be `all` when set. */
  applyTo?: string;
}

export function parseBriefingSectionsCommand(raw: string): ParsedBriefingSectionsCommand {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { matched: false };

  const prefixMatch = trimmed.match(/^\/briefing-sections(?:\s+(.*))?$/i);
  if (!prefixMatch) return { matched: false };

  const rest = (prefixMatch[1] ?? '').trim();
  // The bare command (no args) is rejected — admin must specify a user and
  // either --set, --reset, --list, or --diff (or use the --set-all bulk form).
  if (rest.length === 0) return { matched: false };

  const tokens = rest.split(/\s+/);
  let targetName: string | undefined;
  let setRaw: string | undefined;
  let reset = false;
  let list = false;
  let diff = false;
  let setAllRaw: string | undefined;
  let applyTo: string | undefined;

  const conflictsWithAction = () =>
    setRaw !== undefined || reset || list || diff || setAllRaw !== undefined;

  for (const token of tokens) {
    const userMatch = token.match(/^--user=(.+)$/i);
    if (userMatch && userMatch[1] && userMatch[1].length > 0) {
      if (targetName !== undefined) return { matched: false };
      targetName = userMatch[1];
      continue;
    }
    const setAllMatch = token.match(/^--set-all=(.+)$/i);
    if (setAllMatch && setAllMatch[1] && setAllMatch[1].length > 0) {
      if (conflictsWithAction()) return { matched: false };
      setAllRaw = setAllMatch[1];
      continue;
    }
    const applyToMatch = token.match(/^--apply-to=(.+)$/i);
    if (applyToMatch && applyToMatch[1] && applyToMatch[1].length > 0) {
      if (applyTo !== undefined) return { matched: false };
      applyTo = applyToMatch[1];
      continue;
    }
    const setMatch = token.match(/^--set=(.+)$/i);
    if (setMatch && setMatch[1] && setMatch[1].length > 0) {
      if (conflictsWithAction()) return { matched: false };
      setRaw = setMatch[1];
      continue;
    }
    if (/^--reset$/i.test(token)) {
      if (conflictsWithAction()) return { matched: false };
      reset = true;
      continue;
    }
    if (/^--list$/i.test(token)) {
      if (conflictsWithAction()) return { matched: false };
      list = true;
      continue;
    }
    if (/^--diff$/i.test(token)) {
      if (conflictsWithAction()) return { matched: false };
      diff = true;
      continue;
    }
    return { matched: false };
  }

  // Exactly one action must be present.
  const actionCount =
    (setRaw !== undefined ? 1 : 0) +
    (reset ? 1 : 0) +
    (list ? 1 : 0) +
    (diff ? 1 : 0) +
    (setAllRaw !== undefined ? 1 : 0);
  if (actionCount !== 1) return { matched: false };

  // --set-all REQUIRES --apply-to=all (and only "all").
  if (setAllRaw !== undefined) {
    if (applyTo === undefined) return { matched: false };
    if (applyTo.toLowerCase() !== 'all') return { matched: false };
    if (targetName !== undefined) return { matched: false };
  } else {
    // --apply-to is only valid alongside --set-all.
    if (applyTo !== undefined) return { matched: false };
  }

  // --list may appear bare (no --user). --set / --reset / --diff still require
  // --user.
  if (!list && setAllRaw === undefined && !targetName) return { matched: false };

  return {
    matched: true,
    targetName,
    setRaw,
    reset: reset || undefined,
    list: list || undefined,
    diff: diff || undefined,
    setAllRaw,
    applyTo,
  };
}
