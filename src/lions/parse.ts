/**
 * Parser for the CPS SCORE! master schedule CSV (one tab per network venue).
 *
 * Shape of the tab we read ("(N6) Crane HS"):
 *   - a header block: venue name, address, map link, then two standings tables
 *     side by side (Red Conf. / Blue Conf.) — all ignored.
 *   - per week: a title row (`week 1,"Week 1 - September 19, 2026 - Crane HS"`),
 *     then a column header row (`,TIME,HOME TEAM,VISITING TEAM,SCORE,Notes`),
 *     then one row per game (`,2:00 P.M.,SOUTH LOOP,STEM,,`).
 *     CPS is inconsistent about which of those two rows carries the `week N`
 *     label in column A, and about the dash in the title ("Week 4- October 10").
 *   - after the last week: a `Playoffs- Saturday ... @ Park Name` block whose
 *     game rows are empty, then a free-text city-championship line.
 *
 * Everything here is pure so the whole parser is testable against a fixture of
 * the real sheet (tests/fixtures/n6-crane.csv).
 */

export interface LionsGame {
  /** Week number from the sheet (1-based). */
  week: number;
  /** ISO yyyy-mm-dd. */
  date: string;
  /** Normalized to "2:00 PM". */
  time: string;
  /** Home team, verbatim from the sheet (uppercase). */
  home: string;
  /** Visiting team, verbatim from the sheet (uppercase). */
  away: string;
  /** The other team, verbatim from the sheet (uppercase). */
  opponent: string;
  isHome: boolean;
  /** Venue from the week title, or '' when the sheet omits it. */
  venue: string;
  score?: string;
  notes?: string;
}

export interface ParsedSchedule {
  games: LionsGame[];
  playoffs?: { label: string; dateText: string };
  /** Total CSV rows seen — a cheap "did we get a real sheet" signal. */
  fetchedRows: number;
}

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

/** `9:00 A.M.`, `12:00P.M.`, `1:00 P.M.`, `9 AM` all match. */
const TIME_RE = /^(\d{1,2})(?::(\d{2}))?\s*([AaPp])\.?\s*[Mm]\.?$/;
/** `Week 5- October 17, 2026 - Crane HS` (dash optional, spacing loose). */
const WEEK_TITLE_RE = /^week\s*(\d{1,2})\b\s*[-–—:]?\s*(.*)$/i;
/** Column-A label: `week 3`, `Week 3`, `wk 3`. */
const WEEK_LABEL_RE = /^w(?:ee)?k\.?\s*(\d{1,2})$/i;
const PLAYOFFS_RE = /^playoffs?\b\s*[-–—:]?\s*(.*)$/i;
const DATE_RE = /([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\s*,?\s*(\d{4})/;

/** Team names that stay uppercase when rendered for a human. */
const ACRONYMS = new Set(['STEM', 'ES', 'HS', 'II', 'III', 'IV']);

/**
 * A minimal RFC-4180 CSV reader: quoted fields, `""` escapes, CR/LF endings.
 * The repo has no CSV dependency and this sheet does not need one.
 */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let sawAny = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { quoted = false; }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') { quoted = true; sawAny = true; continue; }
    if (ch === ',') { row.push(field); field = ''; sawAny = true; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; sawAny = false; continue; }
    if (ch === '\r') continue;
    field += ch;
    sawAny = true;
  }
  if (sawAny || field.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

/** `9:00 A.M.` → `9:00 AM`; `12:00P.M.` → `12:00 PM`. Returns '' if not a time. */
export function normalizeTime(raw: string): string {
  const m = TIME_RE.exec(raw.trim());
  if (!m) return '';
  const hour = Number(m[1]);
  if (hour < 1 || hour > 12) return '';
  const minutes = m[2] ?? '00';
  if (Number(minutes) > 59) return '';
  const suffix = m[3]!.toUpperCase() === 'A' ? 'AM' : 'PM';
  return `${hour}:${minutes} ${suffix}`;
}

/** `September 19, 2026` → `2026-09-19`. Returns '' when no date is present. */
export function parseSheetDate(raw: string): string {
  const m = DATE_RE.exec(raw);
  if (!m) return '';
  const month = MONTHS[m[1]!.toLowerCase()];
  if (!month) return '';
  const day = Number(m[2]);
  if (day < 1 || day > 31) return '';
  return `${m[3]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * `SKINNER` → `Skinner`, `LASALLE II` → `Lasalle II`, `STEM` → `STEM`.
 * The sheet shouts every name; alerts and the team page read better in title
 * case, except acronyms (which would otherwise become `Stem`).
 */
export function displayTeamName(raw: string): string {
  return raw
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => (ACRONYMS.has(word.toUpperCase()) ? word.toUpperCase() : word[0]!.toUpperCase() + word.slice(1).toLowerCase()))
    .join(' ');
}

function isHeaderRow(cells: string[]): boolean {
  const joined = cells.map((c) => c.trim().toUpperCase());
  return joined.includes('TIME') && joined.some((c) => c === 'HOME TEAM');
}

/** Venue is whatever trails the date in a week title: `... 2026 - Crane HS`. */
function venueFromTitle(rest: string): string {
  const m = DATE_RE.exec(rest);
  if (!m) return '';
  const tail = rest.slice(m.index + m[0].length).replace(/^\s*[-–—@]\s*/, '').trim();
  return tail.replace(/,+$/, '').trim();
}

export function parseNetworkSheet(csv: string, team: string): ParsedSchedule {
  const rows = parseCsvRows(csv);
  const wanted = team.trim().toUpperCase();
  const games: LionsGame[] = [];
  let playoffs: { label: string; dateText: string } | undefined;

  // What the most recent title/label rows told us.
  let titleWeek: number | null = null;
  let titleDate = '';
  let titleVenue = '';
  let labelWeek: number | null = null;
  // The block we are currently reading game rows for.
  let week: number | null = null;
  let date = '';
  let venue = '';
  let inPlayoffs = false;

  for (const cells of rows) {
    const first = (cells[0] ?? '').trim();

    // Column A label — may sit on the title row or on the TIME row.
    const label = WEEK_LABEL_RE.exec(first);
    if (label) labelWeek = Number(label[1]);
    else if (PLAYOFFS_RE.test(first)) { inPlayoffs = true; week = null; }

    // A week (or playoffs) title can appear in any column.
    for (const cell of cells) {
      const value = cell.trim();
      if (!value) continue;
      const title = WEEK_TITLE_RE.exec(value);
      // A bare `week 4` in column A is a label, not a title — it carries no
      // date, and treating it as one would wipe the date we just read.
      if (title && (title[2] ?? '').trim()) {
        titleWeek = Number(title[1]);
        titleDate = parseSheetDate(title[2] ?? '');
        titleVenue = venueFromTitle(title[2] ?? '');
        inPlayoffs = false;
        break;
      }
      const po = PLAYOFFS_RE.exec(value);
      if (po && (po[1] ?? '').trim()) {
        playoffs = { label: 'Playoffs', dateText: (po[1] ?? '').trim().replace(/,+$/, '') };
        inPlayoffs = true;
        week = null;
        break;
      }
    }

    if (isHeaderRow(cells)) {
      // The header row opens a game block; adopt whatever we have learned.
      if (!inPlayoffs) {
        const resolved = titleWeek ?? labelWeek;
        if (resolved !== null) {
          week = resolved;
          date = titleDate;
          venue = titleVenue;
        }
        // Consume: a following block with no title of its own must not inherit
        // this week's date.
        titleWeek = null;
        labelWeek = null;
        titleDate = '';
        titleVenue = '';
      }
      continue;
    }

    if (week === null || inPlayoffs) continue;

    // Game row: find the time cell, then read home/visitor/score/notes to its right.
    let timeIdx = -1;
    let time = '';
    for (let i = 0; i < cells.length; i++) {
      const t = normalizeTime(cells[i] ?? '');
      if (t) { timeIdx = i; time = t; break; }
    }
    if (timeIdx === -1) continue;

    const home = (cells[timeIdx + 1] ?? '').trim().toUpperCase();
    const away = (cells[timeIdx + 2] ?? '').trim().toUpperCase();
    if (!home || !away) continue;
    if (home !== wanted && away !== wanted) continue;

    const score = (cells[timeIdx + 3] ?? '').trim();
    const notes = (cells[timeIdx + 4] ?? '').trim();
    const isHome = home === wanted;
    const game: LionsGame = {
      week,
      date,
      time,
      home,
      away,
      opponent: isHome ? away : home,
      isHome,
      venue,
    };
    if (score) game.score = score;
    if (notes) game.notes = notes;
    games.push(game);
  }

  games.sort((a, b) => a.week - b.week);
  return playoffs ? { games, playoffs, fetchedRows: rows.length } : { games, fetchedRows: rows.length };
}
