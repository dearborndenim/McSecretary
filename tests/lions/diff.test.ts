import { describe, it, expect } from 'vitest';
import { diffSchedules, formatChangeLine } from '../../src/lions/diff.js';
import type { LionsGame } from '../../src/lions/parse.js';

function game(over: Partial<LionsGame> = {}): LionsGame {
  const base: LionsGame = {
    week: 5,
    date: '2026-10-17',
    time: '1:00 PM',
    home: 'SOUTH LOOP',
    away: 'SKINNER',
    opponent: 'SKINNER',
    isHome: true,
    venue: 'Crane HS',
  };
  return { ...base, ...over };
}

const week5 = game();

describe('diffSchedules', () => {
  it('reports no change for identical schedules', () => {
    expect(diffSchedules([week5], [week5])).toEqual([]);
    expect(diffSchedules([], [])).toEqual([]);
  });

  it('detects a time change', () => {
    const changes = diffSchedules([week5], [game({ time: '2:00 PM' })]);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      week: 5,
      kind: 'time_changed',
      opponent: 'SKINNER',
      before: '1:00 PM',
      after: '2:00 PM',
      summary: 'Week 5 vs Skinner: 1:00 PM → 2:00 PM',
    });
  });

  it('detects an opponent change and reports the new opponent', () => {
    const changes = diffSchedules([week5], [game({ opponent: 'ROWE', away: 'ROWE' })]);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      kind: 'opponent_changed',
      opponent: 'ROWE',
      before: 'Skinner',
      after: 'Rowe',
      summary: 'Week 5: opponent Skinner → Rowe',
    });
  });

  it('detects a date change', () => {
    const changes = diffSchedules([week5], [game({ date: '2026-10-18' })]);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      kind: 'date_changed',
      before: '2026-10-17',
      after: '2026-10-18',
      summary: 'Week 5 vs Skinner: 2026-10-17 → 2026-10-18',
    });
  });

  it('detects a home/away swap', () => {
    const changes = diffSchedules(
      [week5],
      [game({ isHome: false, home: 'SKINNER', away: 'SOUTH LOOP' })],
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      kind: 'home_away_changed',
      before: 'home',
      after: 'away',
      summary: 'Week 5 at Skinner: home → away',
    });
  });

  it('detects an added week', () => {
    const added = game({ week: 7, date: '2026-10-31', time: '9:00 AM', opponent: 'SUDER', away: 'SUDER' });
    const changes = diffSchedules([week5], [week5, added]);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      week: 7,
      kind: 'game_added',
      opponent: 'SUDER',
      before: null,
      after: '2026-10-31 9:00 AM',
      summary: 'Week 7 vs Suder added — 2026-10-31 9:00 AM',
    });
  });

  it('detects a removed week and keeps the old opponent', () => {
    const week6 = game({ week: 6, date: '2026-10-24', time: '9:00 AM', isHome: false, home: 'STEM', away: 'SOUTH LOOP', opponent: 'STEM' });
    const changes = diffSchedules([week5, week6], [week5]);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      week: 6,
      kind: 'game_removed',
      opponent: 'STEM',
      before: '2026-10-24 9:00 AM',
      after: null,
      summary: 'Week 6 at STEM removed — was 2026-10-24 9:00 AM',
    });
  });

  it('produces one change per kind when a single week changes several ways', () => {
    const changes = diffSchedules(
      [week5],
      [game({ date: '2026-10-18', time: '3:00 PM', isHome: false, home: 'SKINNER', away: 'SOUTH LOOP' })],
    );
    expect(changes.map((c) => c.kind)).toEqual(['date_changed', 'time_changed', 'home_away_changed']);
    expect(changes.every((c) => c.week === 5)).toBe(true);
  });

  it('orders changes by week', () => {
    const w3 = game({ week: 3, date: '2026-10-03', opponent: 'ROWE', isHome: false, home: 'ROWE', away: 'SOUTH LOOP' });
    const changes = diffSchedules(
      [w3, week5],
      [{ ...w3, time: '11:00 AM' }, game({ time: '2:00 PM' })],
    );
    expect(changes.map((c) => c.week)).toEqual([3, 5]);
  });

  it('ignores changes to fields that are not part of the game identity', () => {
    // A score arriving is not a schedule change.
    expect(diffSchedules([week5], [game({ score: '3-1' })])).toEqual([]);
  });
});

describe('formatChangeLine', () => {
  it('adds the game-day stamp when one is given', () => {
    const change = diffSchedules([week5], [game({ time: '2:00 PM' })])[0]!;
    expect(formatChangeLine(change, 'Sat 10/17')).toBe('Week 5 vs Skinner (Sat 10/17): 1:00 PM → 2:00 PM');
    expect(formatChangeLine(change)).toBe(change.summary);
  });

  it('leaves add/remove lines alone (the date is already in them)', () => {
    const added = diffSchedules([], [game({ week: 7 })])[0]!;
    expect(formatChangeLine(added, 'Sat 10/17')).toBe('Week 7 vs Skinner added — 2026-10-17 1:00 PM');
  });
});
