import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { initializeSchema } from '../../src/db/schema.js';
import { runLionsCheck, buildAlertMessage, dateStamp, formatScheduleForTelegram } from '../../src/lions/check.js';
import { getActiveAlerts, getLatestSnapshot } from '../../src/lions/store.js';

const CSV = fs.readFileSync(path.join(process.cwd(), 'tests', 'fixtures', 'n6-crane.csv'), 'utf8');
const NOW = new Date('2026-09-09T23:00:00.000Z');
const ENV = { LIONS_BASE_URL: 'https://mcsecretary.up.railway.app/' };

/** Week 5's Lions game moved from 1:00 P.M. to 2:00 P.M. */
const CSV_TIME_CHANGED = CSV.replace(',1:00 P.M.,SOUTH LOOP,SKINNER,,', ',2:00 P.M.,SOUTH LOOP,SKINNER,,');

describe('runLionsCheck', () => {
  let db: Database.Database;
  let notified: string[];
  const fetchOk = (csv: string) => vi.fn(async () => new Response(csv, { status: 200 }));

  const run = (fetchImpl: unknown) =>
    runLionsCheck({
      db,
      fetch: fetchImpl as never,
      notify: async (text) => { notified.push(text); },
      now: () => NOW,
      env: ENV,
    });

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
    notified = [];
  });
  afterEach(() => { db.close(); vi.restoreAllMocks(); });

  it('first run stores a baseline and sends nothing', async () => {
    const result = await run(fetchOk(CSV));
    expect(result).toMatchObject({ ok: true, baseline: true, games: 6, notified: false });
    expect(notified).toEqual([]);
    expect(getActiveAlerts(db)).toEqual([]);
    const snapshot = getLatestSnapshot(db)!;
    expect(snapshot.games).toHaveLength(6);
    expect(snapshot.taken_at).toBe(NOW.toISOString());
  });

  it('requests the configured sheet as CSV with a timeout signal', async () => {
    const doFetch = fetchOk(CSV);
    await run(doFetch);
    const [url, init] = doFetch.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe(
      'https://docs.google.com/spreadsheets/d/1JHw7GN3iiXqzpEV0RxlYL4Uwk9e87jzRLJqCvC3g53A/export?format=csv&gid=974230082',
    );
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('an unchanged sheet sends nothing and stores no new snapshot', async () => {
    await run(fetchOk(CSV));
    const firstId = getLatestSnapshot(db)!.id;

    const result = await run(fetchOk(CSV));
    expect(result).toMatchObject({ ok: true, baseline: false, sheetChanged: false, snapshotSaved: false, games: 6 });
    expect(notified).toEqual([]);
    expect(getLatestSnapshot(db)!.id).toBe(firstId);
  });

  it('a time change sends exactly one message and records one alert', async () => {
    await run(fetchOk(CSV));
    const result = await run(fetchOk(CSV_TIME_CHANGED));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changes.map((c) => c.kind)).toEqual(['time_changed']);
    expect(result.notified).toBe(true);

    expect(notified).toEqual([
      [
        'SCHEDULE CHANGE — South Loop Lions',
        'Week 5 vs Skinner (Sat 10/17): 1:00 PM → 2:00 PM',
        'Live page: https://mcsecretary.up.railway.app/lions',
      ].join('\n'),
    ]);

    const alerts = getActiveAlerts(db);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      week: 5,
      opponent: 'SKINNER',
      kind: 'time_changed',
      summary: 'Week 5 vs Skinner: 1:00 PM → 2:00 PM',
      before: '1:00 PM',
      after: '2:00 PM',
      cleared_at: null,
    });
    expect(getLatestSnapshot(db)!.games[4]).toMatchObject({ week: 5, time: '2:00 PM' });
  });

  it('saves the snapshot silently when the sheet changed but no Lions game did', async () => {
    await run(fetchOk(CSV));
    const firstId = getLatestSnapshot(db)!.id;
    // Another team's game moved.
    const otherTeam = CSV.replace(',9:00 A.M.,GALILEO,OGDEN ES,,', ',11:30 A.M.,GALILEO,OGDEN ES,,');

    const result = await run(fetchOk(otherTeam));
    expect(result).toMatchObject({ ok: true, sheetChanged: true, snapshotSaved: true, notified: false });
    if (result.ok) expect(result.changes).toEqual([]);
    expect(notified).toEqual([]);
    expect(getActiveAlerts(db)).toEqual([]);
    expect(getLatestSnapshot(db)!.id).toBeGreaterThan(firstId);
  });

  it('a network error leaves the previous snapshot untouched', async () => {
    await run(fetchOk(CSV));
    const before = getLatestSnapshot(db)!;

    const result = await run(vi.fn(async () => { throw new Error('socket hang up'); }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/socket hang up/);
    expect(notified).toEqual([]);
    expect(getLatestSnapshot(db)).toEqual(before);
  });

  it('a non-2xx response is an error, not an empty schedule', async () => {
    await run(fetchOk(CSV));
    const before = getLatestSnapshot(db)!;

    const result = await run(vi.fn(async () => new Response('nope', { status: 503 })));
    expect(result).toEqual({ ok: false, error: 'CPS sheet returned HTTP 503' });
    expect(getLatestSnapshot(db)).toEqual(before);
  });

  it('refuses a truncated sheet instead of reporting six removals', async () => {
    await run(fetchOk(CSV));
    const before = getLatestSnapshot(db)!;

    // A half-rendered export: header block plus one Lions game.
    const short = [
      'week 1,"Week 1 - September 19, 2026 - Crane HS",,,,',
      ',TIME,HOME TEAM,VISITING TEAM,SCORE,Notes',
      ',2:00 P.M.,SOUTH LOOP,STEM,,',
    ].join('\n');

    const result = await run(fetchOk(short));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/truncated: parsed 1 SOUTH LOOP games, previous snapshot had 6/);
    expect(notified).toEqual([]);
    expect(getActiveAlerts(db)).toEqual([]);
    expect(getLatestSnapshot(db)).toEqual(before);
  });

  it('refuses an empty first run rather than storing a zero-game baseline', async () => {
    const result = await run(fetchOk(''));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/no SOUTH LOOP games/);
    expect(getLatestSnapshot(db)).toBeNull();
  });

  it('honours LIONS_TEAM and LIONS_VENUE overrides', async () => {
    const result = await runLionsCheck({
      db,
      fetch: fetchOk(CSV) as never,
      notify: async (t) => { notified.push(t); },
      now: () => NOW,
      env: { LIONS_TEAM: 'suder', LIONS_VENUE: 'Somewhere Else' },
    });
    expect(result).toMatchObject({ ok: true, baseline: true, games: 6 });
    expect(getLatestSnapshot(db)!.games[0]).toMatchObject({ week: 1, opponent: 'ROWE' });
  });

  it('records the alerts even when Telegram fails', async () => {
    await run(fetchOk(CSV));
    const result = await runLionsCheck({
      db,
      fetch: fetchOk(CSV_TIME_CHANGED) as never,
      notify: async () => { throw new Error('telegram down'); },
      now: () => NOW,
      env: ENV,
    });
    expect(result).toMatchObject({ ok: true, notified: false });
    expect(getActiveAlerts(db)).toHaveLength(1);
  });

  it('sends one message listing every change', async () => {
    await run(fetchOk(CSV));
    const twoChanges = CSV
      .replace(',1:00 P.M.,SOUTH LOOP,SKINNER,,', ',2:00 P.M.,SOUTH LOOP,SKINNER,,')
      .replace(',10:00 A.M.,SOUTH LOOP,TALCOTT,,', ',10:00 A.M.,SOUTH LOOP,ROWE,,');

    const result = await run(fetchOk(twoChanges));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changes.map((c) => c.kind)).toEqual(['opponent_changed', 'time_changed']);
    expect(notified).toHaveLength(1);
    expect(notified[0]!.split('\n')).toEqual([
      'SCHEDULE CHANGE — South Loop Lions',
      'Week 4 (Sat 10/10): opponent Talcott → Rowe',
      'Week 5 vs Skinner (Sat 10/17): 1:00 PM → 2:00 PM',
      'Live page: https://mcsecretary.up.railway.app/lions',
    ]);
  });
});

describe('dateStamp', () => {
  it('renders the game day', () => {
    expect(dateStamp('2026-10-17')).toBe('Sat 10/17');
    expect(dateStamp('2026-09-19')).toBe('Sat 9/19');
  });
  it('is empty for a missing date', () => {
    expect(dateStamp('')).toBe('');
    expect(dateStamp('TBD')).toBe('');
  });
});

describe('buildAlertMessage', () => {
  it('omits the live-page line when no base URL is configured', () => {
    const message = buildAlertMessage(
      [{ week: 5, opponent: 'SKINNER', opponentLabel: 'Skinner', isHome: true, kind: 'time_changed', summary: 's', before: '1:00 PM', after: '2:00 PM' }],
      [],
      [],
      '',
    );
    expect(message.split('\n')).toEqual([
      'SCHEDULE CHANGE — South Loop Lions',
      'Week 5 vs Skinner: 1:00 PM → 2:00 PM',
    ]);
  });
});

describe('formatScheduleForTelegram', () => {
  it('lists the games and any active alerts', () => {
    const games = [
      { week: 1, date: '2026-09-19', time: '2:00 PM', home: 'SOUTH LOOP', away: 'STEM', opponent: 'STEM', isHome: true, venue: 'Crane HS' },
      { week: 2, date: '2026-09-26', time: '10:00 AM', home: 'SUDER', away: 'SOUTH LOOP', opponent: 'SUDER', isHome: false, venue: 'Crane HS' },
    ];
    const text = formatScheduleForTelegram(games, [{ summary: 'Week 5 vs Skinner: 1:00 PM → 2:00 PM' }], null, 'https://x.test');
    expect(text.split('\n')).toEqual([
      'South Loop Lions — schedule',
      'Wk 1 · Sat 9/19 2:00 PM vs STEM — Crane HS',
      'Wk 2 · Sat 9/26 10:00 AM at Suder — Crane HS',
      '',
      'Active alerts (1):',
      '- Week 5 vs Skinner: 1:00 PM → 2:00 PM',
      'Live page: https://x.test/lions',
    ]);
  });

  it('says so when nothing is stored yet', () => {
    const text = formatScheduleForTelegram([], [], null, '');
    expect(text).toContain('No games stored yet');
    expect(text).toContain('No active schedule-change alerts.');
  });
});
