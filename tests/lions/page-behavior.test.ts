/**
 * Behavioural tests for the team page's own JavaScript.
 *
 * The repo has no jsdom, so the page script is extracted from page.html and run
 * in a `node:vm` sandbox against a minimal DOM/localStorage stub. That is enough
 * to exercise the parts that matter here: reading the injected data block,
 * replacing the static league games with the live ones, the red alert popup and
 * its localStorage dismissal, and the CHANGED pill.
 */

import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import { injectLionsData, loadLionsPageTemplate } from '../../src/lions/page.js';
import type { LionsGame } from '../../src/lions/parse.js';
import type { LionsAlertRow } from '../../src/lions/store.js';

interface StubEl {
  id: string;
  innerHTML: string;
  textContent: string;
  hidden: boolean;
  value: string;
  listeners: Record<string, ((ev: unknown) => void)[]>;
  addEventListener: (ev: string, fn: (ev: unknown) => void) => void;
  setAttribute: (k: string, v: string) => void;
  getAttribute: (k: string) => string | null;
  focus: () => void;
  closest: () => null;
  getBoundingClientRect: () => { top: number };
  style: Record<string, string>;
}

function scriptSource(html: string): string {
  const start = html.indexOf('<script>\n/* @csvregion */');
  const open = html.indexOf('\n', start) + 1;
  const close = html.lastIndexOf('</script>');
  return html.slice(open, close);
}

function dataBlockJson(html: string): string {
  return /<script id="lions-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)![1]!;
}

interface Harness {
  el: (id: string) => StubEl;
  store: Map<string, string>;
  schedule: { date: string; time: string; kind: string; title?: string; where?: string; week?: number; note?: string }[];
  changedWeeks: Record<string, boolean>;
  isLive: boolean;
  click: (id: string) => void;
}

function runPage(html: string, seen: string[] = []): Harness {
  const elements = new Map<string, StubEl>();
  const make = (id: string): StubEl => {
    const attrs: Record<string, string> = {};
    const node: StubEl = {
      id, innerHTML: '', textContent: '', hidden: false, value: '', style: {},
      listeners: {},
      addEventListener(ev, fn) { (node.listeners[ev] ??= []).push(fn); },
      setAttribute(k, v) { attrs[k] = v; },
      getAttribute(k) { return attrs[k] ?? null; },
      focus() {}, closest() { return null; },
      getBoundingClientRect() { return { top: 0 }; },
    };
    return node;
  };
  const el = (id: string): StubEl => {
    let node = elements.get(id);
    if (!node) { node = make(id); elements.set(id, node); }
    return node;
  };
  el('lions-data').textContent = dataBlockJson(html);

  const store = new Map<string, string>(seen.length ? [['slLionsAlertsSeen', JSON.stringify(seen)]] : []);
  const localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  };
  const documentStub = {
    getElementById: (id: string) => (id === 'lions-data' || elements.has(id) ? el(id) : el(id)),
    querySelectorAll: () => [] as unknown[],
    querySelector: () => null,
    body: { appendChild() {}, removeChild() {} },
    addEventListener() {},
    createElement: () => make('created'),
    execCommand: () => true,
  };
  const sandbox: Record<string, unknown> = {
    document: documentStub,
    localStorage,
    navigator: {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    console,
    Math, Date, JSON, Object, Array, String, Number, isNaN, parseInt, parseFloat, RegExp, URL,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(scriptSource(html), sandbox as unknown as vm.Context, { filename: 'page.html' });

  return {
    el,
    store,
    schedule: sandbox.SCHEDULE as Harness['schedule'],
    changedWeeks: sandbox.CHANGED_WEEKS as Record<string, boolean>,
    isLive: sandbox.SCHED_IS_LIVE as boolean,
    click: (id: string) => { (el(id).listeners.click ?? []).forEach((fn) => fn({})); },
  };
}

const LIVE_GAMES: LionsGame[] = [
  { week: 1, date: '2026-09-19', time: '3:00 PM', home: 'SOUTH LOOP', away: 'STEM', opponent: 'STEM', isHome: true, venue: 'Crane HS' },
  { week: 3, date: '2026-10-03', time: '1:00 PM', home: 'ROWE', away: 'SOUTH LOOP', opponent: 'ROWE', isHome: false, venue: 'Crane HS' },
  { week: 5, date: '2026-10-17', time: '2:00 PM', home: 'SOUTH LOOP', away: 'SKINNER', opponent: 'SKINNER', isHome: true, venue: 'Crane HS' },
];

const ALERT: LionsAlertRow = {
  id: 12, created_at: '2026-09-09T23:00:00.000Z', week: 5, opponent: 'SKINNER',
  kind: 'time_changed', summary: 'Week 5 vs Skinner: 1:00 PM → 2:00 PM',
  before: '1:00 PM', after: '2:00 PM', cleared_at: null,
};

const template = loadLionsPageTemplate();
const page = (data: Partial<{ games: LionsGame[]; alerts: LionsAlertRow[]; checkedAt: string | null; live: boolean }>) =>
  injectLionsData(template, { games: [], alerts: [], checkedAt: null, live: false, ...data });

describe('team page — static (live:false)', () => {
  it('keeps the static schedule and shows no popup', () => {
    const h = runPage(template);
    expect(h.isLive).toBe(false);
    const games = h.schedule.filter((r) => r.kind === 'game');
    expect(games).toHaveLength(8);
    expect(games[0]).toMatchObject({ date: '2026-09-19', time: '2:00 PM', title: 'vs STEM' });
    expect(h.el('alert-banner').hidden).toBe(true);
    expect(h.el('sched-calendar').innerHTML).toContain('2:00 PM');
    expect(h.el('sched-calendar').innerHTML).not.toContain('Checked');
    expect(h.el('sched-calendar').innerHTML).toContain(
      'href="https://mcsecretary-triage-production.up.railway.app/lions"'
    );
  });

  it('still pops the banner when a static alerts array is present', () => {
    const h = runPage(page({ alerts: [ALERT] }));
    expect(h.el('alert-banner').hidden).toBe(false);
    expect(h.el('alert-list').innerHTML).toContain('Week 5 vs Skinner: 1:00 PM → 2:00 PM');
  });
});

describe('team page — live data', () => {
  const html = page({ games: LIVE_GAMES, alerts: [ALERT], checkedAt: '2026-09-09T23:00:00.000Z', live: true });

  it('replaces the league games with the live ones and keeps everything else', () => {
    const h = runPage(html);
    expect(h.isLive).toBe(true);
    const games = h.schedule.filter((r) => r.kind === 'game');
    // 3 live games + the 2 static TBD playoff/championship rows.
    expect(games).toHaveLength(5);
    expect(games.slice(0, 3).map((g) => [g.date, g.time, g.title, g.where])).toEqual([
      ['2026-09-19', '3:00 PM', 'vs STEM', 'Crane HS, 2245 W. Jackson Blvd'],
      ['2026-10-03', '1:00 PM', 'at Rowe', 'Crane HS, 2245 W. Jackson Blvd'],
      ['2026-10-17', '2:00 PM', 'vs Skinner', 'Crane HS, 2245 W. Jackson Blvd'],
    ]);
    expect(games.filter((g) => g.time === 'TBD').map((g) => g.title)).toEqual([
      'Network 6 playoffs',
      'SCORE! City Championship (if qualified)',
    ]);
    // Kicks and open-house rows are untouched, so conflict detection still works.
    expect(h.schedule.filter((r) => r.kind === 'kicks')).toHaveLength(8);
    expect(h.schedule.filter((r) => r.kind === 'openhouse')).toHaveLength(4);
    expect(h.el('sched-calendar').innerHTML).toContain('Payton open house');
  });

  it('carries the hand-written note for a date that still has a game', () => {
    const h = runPage(html);
    const oct3 = h.schedule.find((r) => r.kind === 'game' && r.date === '2026-10-03')!;
    expect(oct3.note).toContain('Payton open house ends at 1 PM');
    // 10/24 dropped out of the live sheet, so its note goes with it.
    expect(h.schedule.some((r) => r.kind === 'game' && r.date === '2026-10-24')).toBe(false);
  });

  it('shows the checked-at line under the schedule source note', () => {
    const h = runPage(html);
    expect(h.el('sched-calendar').innerHTML).toContain('Live from the CPS sheet');
    expect(h.el('sched-calendar').innerHTML).toMatch(/Checked Sep 9, 6:00 PM CT/);
    expect(h.el('sched-calendar').innerHTML).not.toContain('mcsecretary-triage-production');
  });

  it('marks the changed week with a red CHANGED pill', () => {
    const h = runPage(html);
    expect(h.changedWeeks).toEqual({ 5: true });
    const rendered = h.el('sched-calendar').innerHTML;
    expect(rendered).toContain('vs Skinner <span class="pill pill-changed">Changed</span>');
    expect((rendered.match(/pill-changed/g) ?? [])).toHaveLength(1);
  });

  it('pops the red banner with one line per alert', () => {
    const h = runPage(html);
    expect(h.el('alert-banner').hidden).toBe(false);
    expect(h.el('alert-list').innerHTML).toBe('<li>Week 5 vs Skinner: 1:00 PM → 2:00 PM</li>');
  });

  it('escapes alert text before it reaches the DOM', () => {
    const h = runPage(page({ alerts: [{ ...ALERT, summary: '<img src=x onerror=alert(1)>' }], live: true, games: LIVE_GAMES }));
    expect(h.el('alert-list').innerHTML).toBe('<li>&lt;img src=x onerror=alert(1)&gt;</li>');
  });

  it('remembers a dismissal so the same alert does not pop again', () => {
    const h = runPage(html);
    h.click('alert-close');
    expect(h.el('alert-banner').hidden).toBe(true);
    expect(JSON.parse(h.store.get('slLionsAlertsSeen')!)).toEqual(['12']);

    // Next load on that device: no popup, but the CHANGED pill stays.
    const again = runPage(html, ['12']);
    expect(again.el('alert-banner').hidden).toBe(true);
    expect(again.changedWeeks).toEqual({ 5: true });
    expect(again.el('sched-calendar').innerHTML).toContain('pill-changed');
  });

  it('pops again when a new alert arrives', () => {
    const withNew = page({
      games: LIVE_GAMES,
      alerts: [{ ...ALERT, id: 13, week: 3, summary: 'Week 3 at Rowe: 1:00 PM → 11:00 AM' }, ALERT],
      checkedAt: '2026-09-09T23:00:00.000Z',
      live: true,
    });
    const h = runPage(withNew, ['12']);
    expect(h.el('alert-banner').hidden).toBe(false);
    expect(h.el('alert-list').innerHTML).toContain('Week 3 at Rowe');
    expect(h.changedWeeks).toEqual({ 3: true, 5: true });
  });

  it('ignores a live payload with no games', () => {
    const h = runPage(page({ games: [], live: true }));
    expect(h.isLive).toBe(false);
    expect(h.schedule.filter((r) => r.kind === 'game')).toHaveLength(8);
  });
});
