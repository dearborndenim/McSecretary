import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import {
  judgeFeed, evaluateRun, saveRun, listFeedRows, formatFeedSection, buildFeedsView, parseFeedsResponse,
  type HandFeed, type HandCallResult, type FeedWatchConfig,
} from '../../src/spine/feed-watch.js';
import { runExpirySweep } from '../../src/spine/jobs.js';

const H = 3_600_000;
const T0 = '2026-11-26T12:00:00.000Z';
const at = (hoursAfterT0: number) => new Date(Date.parse(T0) + hoursAfterT0 * H).toISOString();
const feed = (o: Partial<HandFeed> = {}): HandFeed => ({
  key: 'google_insights', label: 'Google Ads daily insights', last_attempt_at: T0, last_success_at: T0,
  last_status: 'ok', last_error: null, expected_every_hours: 24, data_through: '2026-11-25', ...o,
});

describe('judgeFeed', () => {
  it('stale only past 2 x expected + 1 hour since the last success', () => {
    expect(judgeFeed(feed(), at(49), T0).state).toBe('ok'); // 49 h = 2 x 24 + 1, not past it
    expect(judgeFeed(feed(), at(49.1), T0)).toEqual({ state: 'stale', detail: 'last success 49 h ago, expected every 24 h' });
    expect(judgeFeed(feed({ expected_every_hours: 2 }), at(5.1), T0).state).toBe('stale');
    expect(judgeFeed(feed({ expected_every_hours: null }), at(1000), T0).state).toBe('ok'); // status only
  });

  it('an error with a recent success is ok; with an old or no success it is error', () => {
    const errored = feed({ last_status: 'error', last_error: 'Google Ads API 401' });
    expect(judgeFeed(errored, at(23), T0).state).toBe('ok');
    expect(judgeFeed(errored, at(25), T0)).toEqual({ state: 'error', detail: 'Google Ads API 401' });
    expect(judgeFeed({ ...errored, last_success_at: null }, at(0), T0).state).toBe('error');
    expect(judgeFeed({ ...errored, expected_every_hours: null }, at(0), T0).state).toBe('error');
  });

  it('a never-run feed is judged from when the watch first saw it', () => {
    const never = feed({ last_status: 'never', last_success_at: null, last_attempt_at: null });
    expect(judgeFeed(never, at(49), T0).state).toBe('ok');
    expect(judgeFeed(never, at(50), T0).state).toBe('stale');
    expect(judgeFeed({ ...never, expected_every_hours: null }, at(500), T0).state).toBe('ok'); // not configured
  });

  it('an expected key the hand does not report is missing', () => {
    expect(judgeFeed(undefined, T0, T0).state).toBe('missing');
  });
});

describe('evaluateRun', () => {
  const config: FeedWatchConfig = { brand: 'dearborn-denim', hands: { 'ad-manager': { expected: ['google_insights', 'returns'] } } };
  const ok = (feeds: HandFeed[]): Map<string, HandCallResult> => new Map([['ad-manager', { ok: true, feeds }]]);
  const down = (detail = 'feeds route not deployed'): Map<string, HandCallResult> => new Map([['ad-manager', { ok: false, detail }]]);

  it('missing expected key is bad; an unexpected extra feed is judged on its own interval', () => {
    const ev = evaluateRun([], ok([feed(), feed({ key: 'extra', expected_every_hours: 1, last_success_at: at(-10) })]), config, T0);
    const by = Object.fromEntries(ev.upserts.map((r) => [r.key, r.state]));
    expect(by).toEqual({ '*': 'ok', google_insights: 'ok', returns: 'missing', extra: 'stale' });
    expect(ev.turnedBad.map((r) => r.key).sort()).toEqual(['extra', 'returns']);
  });

  it('unreachable only after two consecutive failed calls, then alerted once', () => {
    const first = evaluateRun([], down(), config, at(0));
    expect(first.upserts[0]).toMatchObject({ key: '*', state: 'ok', fail_count: 1 });
    expect(first.turnedBad).toHaveLength(0);
    const second = evaluateRun(first.upserts, down(), config, at(1));
    expect(second.upserts[0]).toMatchObject({ key: '*', state: 'unreachable', fail_count: 2, detail: 'feeds route not deployed', since: at(1) });
    expect(second.turnedBad).toHaveLength(1);
    const third = evaluateRun(second.upserts, down(), config, at(25));
    expect(third.turnedBad).toHaveLength(0); // not re-alerted the next day
    expect(third.upserts[0]!.since).toBe(at(1));
    // A success in between resets the count.
    const blip = evaluateRun(evaluateRun([], down(), config, at(0)).upserts, ok([feed({ key: 'returns' }), feed()]), config, at(1));
    expect(evaluateRun(blip.upserts, down(), config, at(2)).upserts[0]).toMatchObject({ state: 'ok', fail_count: 1 });
  });

  it('alerts once per bad spell: bad to another bad is quiet, recovery then failure alerts again', () => {
    const feeds = (o: Partial<HandFeed>) => ok([feed({ key: 'returns' }), feed(o)]);
    const r1 = evaluateRun([], feeds({ last_status: 'error', last_success_at: at(-30), last_error: 'boom' }), config, at(0));
    expect(r1.turnedBad.map((r) => `${r.key}:${r.state}`)).toEqual(['google_insights:error']);
    const r2 = evaluateRun(r1.upserts, feeds({ last_status: 'ok', last_success_at: at(-60) }), config, at(1));
    expect(r2.upserts.find((r) => r.key === 'google_insights')).toMatchObject({ state: 'stale', since: at(0), last_alerted_at: at(0) });
    expect(r2.turnedBad).toHaveLength(0);
    const r3 = evaluateRun(r2.upserts, feeds({ last_success_at: at(2) }), config, at(2));
    expect(r3.recovered.map((r) => r.key)).toEqual(['google_insights']);
    expect(r3.upserts.find((r) => r.key === 'google_insights')).toMatchObject({ state: 'ok', last_alerted_at: null, recovered_at: at(2) });
    const r4 = evaluateRun(r3.upserts, feeds({ last_status: 'error', last_success_at: at(2), last_error: 'boom' }), config, at(30));
    expect(r4.turnedBad.map((r) => r.key)).toEqual(['google_insights']);
  });
});

describe('feed watch storage, sweep and C2', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); initializeSchema(db); });
  afterEach(() => db.close());

  const config: FeedWatchConfig = {
    brand: 'dearborn-denim',
    hands: { 'ad-manager': { expected: ['google_insights'] }, 'kanban-purchaser': { expected: ['order_batcher'] } },
  };
  const results = (adFeeds: HandFeed[], kanban: HandCallResult): Map<string, HandCallResult> =>
    new Map([['ad-manager', { ok: true, feeds: adFeeds }], ['kanban-purchaser', kanban]]);
  const run = (r: Map<string, HandCallResult>, now: string) => saveRun(db, evaluateRun(listFeedRows(db), r, config, now), now);
  const chiefTasks = () => db.prepare("SELECT payload FROM spine_events WHERE event_type = 'grok_task_chief'").all() as { payload: string }[];

  it('one Chief task per run with newly bad feeds, a sweep section while bad, one recovery line', () => {
    const bad = feed({ last_status: 'error', last_success_at: '2026-11-02T06:00:00.000Z', last_error: 'Google Ads API 401' });
    const notDeployed: HandCallResult = { ok: false, detail: 'feeds route not deployed' };
    expect(run(results([bad], notDeployed), at(0))).not.toBeNull();
    expect(run(results([bad], notDeployed), at(1))).not.toBeNull(); // kanban's second strike
    expect(run(results([bad], notDeployed), at(2))).toBeNull();
    const tasks = chiefTasks().map((t) => JSON.parse(t.payload));
    expect(tasks.map((t) => t.args.feeds.map((f: { hand: string; key: string }) => `${f.hand} ${f.key}`))).toEqual([
      ['ad-manager google_insights'], ['kanban-purchaser *'],
    ]);
    expect(tasks[0]).toMatchObject({ kind: 'feed_down', notify: false, reply_type: null, filed_by: 'mcsecretary' });

    const view = buildFeedsView(listFeedRows(db), at(2));
    expect(view.ok).toBe(false);
    expect(view.feeds.map((f) => `${f.hand}/${f.key}/${f.state}`)).toEqual([
      'ad-manager/google_insights/error', 'kanban-purchaser/*/unreachable',
    ]);

    const section = formatFeedSection(listFeedRows(db), at(17));
    expect(section[0]).toBe('Feeds: 2 bad');
    expect(section[1]).toContain('ad-manager google_insights (Google Ads daily insights): error since');
    expect(section[1]).toContain('Google Ads API 401; last ok Nov 2 00:00');
    expect(section[2]).toContain('kanban-purchaser feeds route: unreachable since Nov 26 07:00 — feeds route not deployed');
    // The sweep speaks even with nothing else to say.
    expect(runExpirySweep(db, at(17), undefined, section)).toBe(['Spine health', ...section].join('\n'));
    expect(runExpirySweep(db, at(17))).toBeNull();

    run(results([feed({ last_success_at: at(3) })], { ok: true, feeds: [feed({ key: 'order_batcher', expected_every_hours: 2, last_success_at: at(3) })] }), at(3));
    expect(chiefTasks()).toHaveLength(2); // recovery is not an alert
    const after = formatFeedSection(listFeedRows(db), at(17));
    expect(after).toEqual([
      'Feed recovered: ad-manager google_insights at Nov 26 09:00',
      'Feed recovered: kanban-purchaser feeds route at Nov 26 09:00',
    ]);
    expect(formatFeedSection(listFeedRows(db), at(27))).toEqual([]); // only the day it recovers
  });

  it('parses C1 and refuses a body that is not a feeds list', () => {
    expect(parseFeedsResponse('<html>')).toBeNull();
    expect(parseFeedsResponse('{"service":"x"}')).toBeNull();
    const parsed = parseFeedsResponse(JSON.stringify({
      service: 'ad-manager', as_of: T0,
      feeds: [{ key: 'google_insights', label: 'Google', last_attempt_at: T0, last_success_at: null, last_status: 'error',
        last_error: 'line1\nline2', expected_every_hours: 24, data_through: '2026-11-25' }, { label: 'no key' }],
    }));
    expect(parsed).toEqual([{ key: 'google_insights', label: 'Google', last_attempt_at: T0, last_success_at: null,
      last_status: 'error', last_error: 'line1 line2', expected_every_hours: 24, data_through: '2026-11-25' }]);
  });
});
