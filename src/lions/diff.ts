/**
 * Diff two snapshots of the Lions' games, keyed by week — CPS edits the master
 * sheet in place, so "week 5" is the only stable identity a game has.
 */

import { displayTeamName, type LionsGame } from './parse.js';

export type ScheduleChangeKind =
  | 'time_changed'
  | 'opponent_changed'
  | 'date_changed'
  | 'home_away_changed'
  | 'game_added'
  | 'game_removed';

export interface ScheduleChange {
  week: number;
  /** The new opponent, verbatim from the sheet — or the old one for a removal. */
  opponent: string;
  /** Same opponent in human form (`Skinner`, `STEM`). */
  opponentLabel: string;
  /** Whether the game is at home after the change (before, for a removal). */
  isHome: boolean;
  kind: ScheduleChangeKind;
  /** One human sentence, e.g. `Week 5 vs Skinner: 1:00 PM → 2:00 PM`. */
  summary: string;
  before: string | null;
  after: string | null;
}

function describe(game: LionsGame): string {
  return `${game.date} ${game.time}`;
}

/**
 * The one formatter for a change. `dateStamp` (e.g. `Sat 10/17`) is added for
 * the Telegram message, where the game day matters; the stored `summary` leaves
 * it out because the page already shows the date on the row.
 */
export function formatChangeLine(change: ScheduleChange, dateStamp?: string): string {
  const stamp = dateStamp ? ` (${dateStamp})` : '';
  const side = change.isHome ? 'vs' : 'at';
  const prefix = `Week ${change.week} ${side} ${change.opponentLabel}`;
  switch (change.kind) {
    case 'opponent_changed':
      return `Week ${change.week}${stamp}: opponent ${change.before} → ${change.after}`;
    case 'game_added':
      return `${prefix} added — ${change.after}`;
    case 'game_removed':
      return `${prefix} removed — was ${change.before}`;
    default:
      return `${prefix}${stamp}: ${change.before} → ${change.after}`;
  }
}

function change(
  kind: ScheduleChangeKind,
  game: LionsGame,
  before: string | null,
  after: string | null,
): ScheduleChange {
  const partial: ScheduleChange = {
    week: game.week,
    opponent: game.opponent,
    opponentLabel: displayTeamName(game.opponent),
    isHome: game.isHome,
    kind,
    summary: '',
    before,
    after,
  };
  partial.summary = formatChangeLine(partial);
  return partial;
}

/**
 * Returns one change per differing field, so a week that moved day AND time
 * produces two changes (Robert wants to see both, not a merged blob).
 * Ordered by week, then by the kind order below.
 */
export function diffSchedules(prev: LionsGame[], next: LionsGame[]): ScheduleChange[] {
  const before = new Map(prev.map((g) => [g.week, g]));
  const after = new Map(next.map((g) => [g.week, g]));
  const weeks = [...new Set([...before.keys(), ...after.keys()])].sort((a, b) => a - b);
  const changes: ScheduleChange[] = [];

  for (const week of weeks) {
    const was = before.get(week);
    const now = after.get(week);

    if (!was && now) {
      changes.push(change('game_added', now, null, describe(now)));
      continue;
    }
    if (was && !now) {
      changes.push(change('game_removed', was, describe(was), null));
      continue;
    }
    if (!was || !now) continue;

    if (was.opponent !== now.opponent) {
      changes.push(change('opponent_changed', now, displayTeamName(was.opponent), displayTeamName(now.opponent)));
    }
    if (was.date !== now.date) {
      changes.push(change('date_changed', now, was.date, now.date));
    }
    if (was.time !== now.time) {
      changes.push(change('time_changed', now, was.time, now.time));
    }
    if (was.isHome !== now.isHome) {
      changes.push(change('home_away_changed', now, was.isHome ? 'home' : 'away', now.isHome ? 'home' : 'away'));
    }
  }

  return changes;
}
