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
 * Polish 2026-04-25 added clone-from:
 *   /briefing-sections --user=<target> --clone-from=<src> → copy src's pref onto target
 *
 * Polish 2026-04-26 added history + revert:
 *   /briefing-sections --user=<name> --history [--days=N]  → audit history for that user
 *   /briefing-sections --user=<name> --revert              → undo last action for that user
 *
 * Polish 2026-04-27 extended --revert with --to=<audit-id>:
 *   /briefing-sections --user=<name> --revert --to=<id>    → revert to a specific audit row
 *
 * Polish 2026-04-28 extended --history with --json:
 *   /briefing-sections --user=<name> --history --json [--days=N]
 *     → JSON array (programmatic consumers) instead of human-readable lines
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
  /**
   * Source user name from `--clone-from=<name>`. Present only when the
   * `--clone-from=` form matched. Must be paired with `--user=<target>` (and
   * the target must differ from the source — handler enforces).
   */
  cloneFrom?: string;
  /**
   * True when the `--history` flag was present. Mutually exclusive with all
   * other action flags. Requires `--user`. Optional `--days=N` (default 7,
   * clamp [1, 90]).
   */
  history?: boolean;
  /**
   * Days window for the `--history` form. Positive integer. Defaults to 7
   * when --history is present and --days is unset. Caller clamps to [1, 90].
   */
  historyDays?: number;
  /**
   * True when the `--revert` flag was present. Mutually exclusive with all
   * other action flags. Requires `--user`.
   */
  revert?: boolean;
  /**
   * True when the `--json` flag was present. Only valid alongside `--history`.
   * When set, the handler emits a JSON array (newest-first) of audit rows
   * instead of human-readable lines. Stale-section filtering is skipped in
   * JSON mode so programmatic consumers receive the raw stored sections.
   *
   * Polish 6 (2026-04-28).
   */
  json?: boolean;
  /**
   * Numeric audit-row id from `--to=<audit-id>`. Only valid alongside
   * `--revert`. When set, the handler reverts to that specific historical
   * audit row (writes its `sections_json` back to the user). The handler
   * validates that the id exists, belongs to the target user, and is not
   * the most-recent row (which would be a no-op).
   */
  revertTo?: number;
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
  let cloneFrom: string | undefined;
  let history = false;
  let historyDays: number | undefined;
  let revert = false;
  let revertTo: number | undefined;
  let json = false;

  const conflictsWithAction = () =>
    setRaw !== undefined ||
    reset ||
    list ||
    diff ||
    setAllRaw !== undefined ||
    cloneFrom !== undefined ||
    history ||
    revert;

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
    const cloneFromMatch = token.match(/^--clone-from=(.+)$/i);
    if (cloneFromMatch && cloneFromMatch[1] && cloneFromMatch[1].length > 0) {
      if (conflictsWithAction()) return { matched: false };
      cloneFrom = cloneFromMatch[1];
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
    if (/^--history$/i.test(token)) {
      if (conflictsWithAction()) return { matched: false };
      history = true;
      continue;
    }
    const daysMatch = token.match(/^--days=(.+)$/i);
    if (daysMatch && daysMatch[1] && daysMatch[1].length > 0) {
      if (historyDays !== undefined) return { matched: false };
      const parsed = Number.parseInt(daysMatch[1], 10);
      if (!Number.isFinite(parsed) || String(parsed) !== daysMatch[1].trim() || parsed <= 0) {
        return { matched: false };
      }
      historyDays = parsed;
      continue;
    }
    if (/^--revert$/i.test(token)) {
      if (conflictsWithAction()) return { matched: false };
      revert = true;
      continue;
    }
    if (/^--json$/i.test(token)) {
      // --json is a modifier (not an action). Only valid alongside --history.
      // Validation that --history is set happens after the loop.
      if (json) return { matched: false };
      json = true;
      continue;
    }
    const toMatch = token.match(/^--to=(.+)$/i);
    if (toMatch && toMatch[1] && toMatch[1].length > 0) {
      if (revertTo !== undefined) return { matched: false };
      const parsed = Number.parseInt(toMatch[1], 10);
      if (!Number.isFinite(parsed) || String(parsed) !== toMatch[1].trim() || parsed <= 0) {
        return { matched: false };
      }
      revertTo = parsed;
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
    (setAllRaw !== undefined ? 1 : 0) +
    (cloneFrom !== undefined ? 1 : 0) +
    (history ? 1 : 0) +
    (revert ? 1 : 0);
  if (actionCount !== 1) return { matched: false };

  // --days is only valid alongside --history.
  if (historyDays !== undefined && !history) return { matched: false };

  // --to is only valid alongside --revert.
  if (revertTo !== undefined && !revert) return { matched: false };

  // --json is only valid alongside --history (mutually-exclusive with all
  // other action flags by virtue of --history being the only carrier).
  if (json && !history) return { matched: false };

  // --set-all REQUIRES --apply-to=all (and only "all").
  if (setAllRaw !== undefined) {
    if (applyTo === undefined) return { matched: false };
    if (applyTo.toLowerCase() !== 'all') return { matched: false };
    if (targetName !== undefined) return { matched: false };
  } else {
    // --apply-to is only valid alongside --set-all.
    if (applyTo !== undefined) return { matched: false };
  }

  // --clone-from requires --user=<target> (different user from source).
  if (cloneFrom !== undefined && targetName === undefined) return { matched: false };

  // --history / --revert require --user.
  if ((history || revert) && targetName === undefined) return { matched: false };

  // --list may appear bare (no --user). --set / --reset / --diff / --clone-from
  // / --history / --revert still require --user.
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
    cloneFrom,
    history: history || undefined,
    historyDays,
    revert: revert || undefined,
    revertTo,
    json: json || undefined,
  };
}
