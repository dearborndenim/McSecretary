import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  displayTeamName,
  normalizeTime,
  parseCsvRows,
  parseNetworkSheet,
  parseSheetDate,
} from '../../src/lions/parse.js';

const FIXTURE = path.join(process.cwd(), 'tests', 'fixtures', 'n6-crane.csv');
const csv = fs.readFileSync(FIXTURE, 'utf8');

describe('parseNetworkSheet — real CPS "(N6) Crane HS" tab', () => {
  const parsed = parseNetworkSheet(csv, 'SOUTH LOOP');

  it('finds exactly the six Lions games with the right week/date/time/opponent/side', () => {
    expect(parsed.games).toHaveLength(6);
    expect(parsed.games.map((g) => [g.week, g.date, g.time, g.opponent, g.isHome])).toEqual([
      [1, '2026-09-19', '2:00 PM', 'STEM', true],
      [2, '2026-09-26', '10:00 AM', 'SUDER', false],
      [3, '2026-10-03', '1:00 PM', 'ROWE', false],
      [4, '2026-10-10', '10:00 AM', 'TALCOTT', true],
      [5, '2026-10-17', '1:00 PM', 'SKINNER', true],
      [6, '2026-10-24', '9:00 AM', 'STEM', false],
    ]);
  });

  it('keeps home/away verbatim and derives the venue from the week title', () => {
    const week2 = parsed.games[1]!;
    expect(week2.home).toBe('SUDER');
    expect(week2.away).toBe('SOUTH LOOP');
    expect(parsed.games.every((g) => g.venue === 'Crane HS')).toBe(true);
  });

  it('leaves score and notes off when the sheet has none', () => {
    expect(parsed.games.every((g) => g.score === undefined && g.notes === undefined)).toBe(true);
  });

  it('ignores the standings block (SOUTH LOOP appears there too)', () => {
    // The Blue Conf. standings list "SOUTH LOOP,(0-0-0) 0 pts" — no time cell, so
    // it must not become a game.
    expect(parsed.games.some((g) => g.opponent.includes('0-0-0'))).toBe(false);
    expect(parsed.games.some((g) => g.time === '')).toBe(false);
  });

  it('captures the playoffs header', () => {
    expect(parsed.playoffs).toEqual({
      label: 'Playoffs',
      dateText: 'Saturday October 26, 2026 @ Park Name',
    });
  });

  it('reports the number of rows read', () => {
    expect(parsed.fetchedRows).toBeGreaterThan(70);
  });

  it('finds another team just as well', () => {
    const stem = parseNetworkSheet(csv, 'STEM');
    expect(stem.games).toHaveLength(6);
    expect(stem.games[0]).toMatchObject({ week: 1, opponent: 'SOUTH LOOP', isHome: false });
    expect(stem.games[5]).toMatchObject({ week: 6, opponent: 'SOUTH LOOP', isHome: true });
  });

  it('accepts a lowercase team argument', () => {
    expect(parseNetworkSheet(csv, 'south loop').games).toHaveLength(6);
  });
});

describe('parseNetworkSheet — tolerance for how CPS writes a week header', () => {
  const header = ',TIME,HOME TEAM,VISITING TEAM,SCORE,Notes';
  const game = ',1:00 P.M.,SOUTH LOOP,SKINNER,,';

  it('reads the week label from the title row', () => {
    const sheet = ['week 5,"Week 5 - October 17, 2026 - Crane HS",,,,', header, game].join('\n');
    expect(parseNetworkSheet(sheet, 'SOUTH LOOP').games[0]).toMatchObject({
      week: 5, date: '2026-10-17', time: '1:00 PM', venue: 'Crane HS',
    });
  });

  it('reads the week label from the following TIME row', () => {
    const sheet = [
      ',"Week 5 - October 17, 2026 - Crane HS",,,,',
      `week 5${header}`,
      game,
    ].join('\n');
    expect(parseNetworkSheet(sheet, 'SOUTH LOOP').games[0]).toMatchObject({
      week: 5, date: '2026-10-17', time: '1:00 PM', venue: 'Crane HS',
    });
  });

  it('works from the column-A label alone when the title row is missing', () => {
    const sheet = ['week 7,TIME,HOME TEAM,VISITING TEAM,SCORE,Notes', game].join('\n');
    expect(parseNetworkSheet(sheet, 'SOUTH LOOP').games[0]).toMatchObject({ week: 7, date: '', time: '1:00 PM' });
  });

  it('handles the missing space in "Week 4- October 10, 2026"', () => {
    const sheet = [',"Week 4- October 10, 2026 - Crane HS",,,,', `week 4${header}`, game].join('\n');
    expect(parseNetworkSheet(sheet, 'SOUTH LOOP').games[0]).toMatchObject({ week: 4, date: '2026-10-10' });
  });

  it('carries score and notes through when CPS fills them in', () => {
    const sheet = [
      'week 1,"Week 1 - September 19, 2026 - Crane HS",,,,',
      header,
      ',2:00 P.M.,SOUTH LOOP,STEM,3-1,"Field moved, north pitch"',
    ].join('\n');
    expect(parseNetworkSheet(sheet, 'SOUTH LOOP').games[0]).toMatchObject({
      score: '3-1', notes: 'Field moved, north pitch',
    });
  });

  it('skips the playoffs block instead of inventing games', () => {
    const sheet = [
      ',"Playoffs- Saturday October 26, 2026 @ Park Name",,,,',
      `Playoffs${header}`,
      ',9:00 A.M.,SOUTH LOOP,SKINNER,,',
    ].join('\n');
    const out = parseNetworkSheet(sheet, 'SOUTH LOOP');
    expect(out.games).toEqual([]);
    expect(out.playoffs?.label).toBe('Playoffs');
  });

  it('does not let a later block inherit the previous week date', () => {
    const sheet = [
      'week 1,"Week 1 - September 19, 2026 - Crane HS",,,,',
      header,
      ',2:00 P.M.,SOUTH LOOP,STEM,,',
      'week 2,TIME,HOME TEAM,VISITING TEAM,SCORE,Notes',
      ',9:00 A.M.,SUDER,SOUTH LOOP,,',
    ].join('\n');
    const games = parseNetworkSheet(sheet, 'SOUTH LOOP').games;
    expect(games[0]!.date).toBe('2026-09-19');
    expect(games[1]!.date).toBe('');
  });
});

describe('CSV reader', () => {
  it('keeps commas inside quoted fields', () => {
    const rows = parseCsvRows('week 1,"Week 1 - September 19, 2026 - Crane HS",,,,\n');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(['week 1', 'Week 1 - September 19, 2026 - Crane HS', '', '', '', '']);
  });

  it('handles escaped quotes and CRLF endings', () => {
    const rows = parseCsvRows('a,"say ""hi""",b\r\nc,d,e\r\n');
    expect(rows).toEqual([['a', 'say "hi"', 'b'], ['c', 'd', 'e']]);
  });

  it('keeps a trailing row without a newline', () => {
    expect(parseCsvRows('a,b')).toEqual([['a', 'b']]);
  });
});

describe('normalizeTime', () => {
  it('normalizes every shape the sheet uses', () => {
    expect(normalizeTime('9:00 A.M.')).toBe('9:00 AM');
    expect(normalizeTime('12:00P.M.')).toBe('12:00 PM');
    expect(normalizeTime('1:00 P.M.')).toBe('1:00 PM');
    expect(normalizeTime('  2:00   p.m. ')).toBe('2:00 PM');
    expect(normalizeTime('9 AM')).toBe('9:00 AM');
  });

  it('rejects anything that is not a clock time', () => {
    for (const bad of ['', 'TIME', 'SOUTH LOOP', '(0-0-0) 0 pts', '13:00 P.M.', '9:75 A.M.', 'Notes']) {
      expect(normalizeTime(bad)).toBe('');
    }
  });
});

describe('parseSheetDate', () => {
  it('reads the dates CPS writes', () => {
    expect(parseSheetDate('Week 1 - September 19, 2026 - Crane HS')).toBe('2026-09-19');
    expect(parseSheetDate('Saturday October 26, 2026 @ Park Name')).toBe('2026-10-26');
    expect(parseSheetDate('Starts Saturday, November 7th, 2026')).toBe('2026-11-07');
  });

  it('returns empty when there is no date', () => {
    expect(parseSheetDate('Week 9 - TBD')).toBe('');
  });
});

describe('displayTeamName', () => {
  it('title-cases the shouted names but keeps acronyms', () => {
    expect(displayTeamName('SKINNER')).toBe('Skinner');
    expect(displayTeamName('SOUTH LOOP')).toBe('South Loop');
    expect(displayTeamName('LASALLE II')).toBe('Lasalle II');
    expect(displayTeamName('STEM')).toBe('STEM');
    expect(displayTeamName('OGDEN ES')).toBe('Ogden ES');
    expect(displayTeamName('YOUNG HS')).toBe('Young HS');
  });
});
