/**
 * Behavioural tests for the Training tab's own JavaScript.
 *
 * Same approach as page-behavior.test.ts: the page script is extracted from
 * page.html and run in a `node:vm` sandbox against a minimal DOM stub. The stub
 * does not parse HTML, so anything written through a container's innerHTML is
 * asserted against that string, while anything the script later updates by id
 * (captions, dots, transforms, the accordion) is read off the stub node.
 *
 * The sandbox deliberately has no requestAnimationFrame, which is the same path
 * the page takes under reduced motion: positions jump straight to the frame.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import vm from 'node:vm';
import { loadLionsPageTemplate } from '../../src/lions/page.js';

interface StubEl {
  id: string;
  innerHTML: string;
  textContent: string;
  hidden: boolean;
  value: string;
  disabled: boolean;
  listeners: Record<string, ((ev: unknown) => void)[]>;
  addEventListener: (ev: string, fn: (ev: unknown) => void) => void;
  setAttribute: (k: string, v: string) => void;
  getAttribute: (k: string) => string | null;
  focus: () => void;
  closest: () => null;
  getBoundingClientRect: () => { top: number };
  style: Record<string, string>;
}

interface Sandbox {
  [key: string]: unknown;
  COACHING: Record<string, unknown>;
  COACH_OPEN: Record<string, number>;
  TABS: string[];
  TACTICS: { id: string; frames: { caption: string }[] }[];
  TP_STATE: Record<string, { frame: number; playing: boolean }>;
  state: { player: string; tab: string };
  renderProfile: () => void;
}

interface Harness {
  el: (id: string) => StubEl;
  sandbox: Sandbox;
  click: (id: string) => void;
  html: (id: string) => string;
  card: (picId: string) => string;
}

const template = loadLionsPageTemplate();

function scriptSource(html: string): string {
  const start = html.indexOf('<script>\n/* @csvregion */');
  const open = html.indexOf('\n', start) + 1;
  const close = html.lastIndexOf('</script>');
  return html.slice(open, close);
}

function dataBlockJson(html: string): string {
  return /<script id="lions-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)![1]!;
}

function runPage(opts: { reducedMotion?: boolean } = {}): Harness {
  const elements = new Map<string, StubEl>();
  const make = (id: string): StubEl => {
    const attrs: Record<string, string> = {};
    const node: StubEl = {
      id, innerHTML: '', textContent: '', hidden: false, value: '', disabled: false, style: {},
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
  el('lions-data').textContent = dataBlockJson(template);

  const store = new Map<string, string>();
  const sandbox: Record<string, unknown> = {
    document: {
      getElementById: (id: string) => el(id),
      querySelectorAll: () => [] as unknown[],
      querySelector: () => null,
      body: { appendChild() {}, removeChild() {} },
      addEventListener() {},
      createElement: () => make('created'),
      execCommand: () => true,
    },
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    },
    navigator: {},
    matchMedia: (q: string) => ({ media: q, matches: !!opts.reducedMotion }),
    pageYOffset: 0,
    scrollTo: () => {},
    // Resolved late so vi.useFakeTimers() (which swaps the globals) is honoured.
    setTimeout: (fn: () => void, ms?: number) => globalThis.setTimeout(fn, ms),
    clearTimeout: (t: unknown) => globalThis.clearTimeout(t as ReturnType<typeof setTimeout>),
    console,
    Math, Date, JSON, Object, Array, String, Number, isNaN, parseInt, parseFloat, RegExp, URL,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(scriptSource(template), sandbox as unknown as vm.Context, { filename: 'page.html' });

  const html = (id: string): string => el(id).innerHTML;
  return {
    el,
    sandbox: sandbox as unknown as Sandbox,
    html,
    click: (id: string) => { (el(id).listeners.click ?? []).forEach((fn) => fn({})); },
    card: (picId: string) => {
      const all = html('training-pictures') + html('training-gk-picture');
      const open = all.indexOf(`id="tp-${picId}-card"`);
      expect(open, `card ${picId} rendered`).toBeGreaterThan(-1);
      const end = all.indexOf('</article>', open);
      return all.slice(open, end);
    },
  };
}

const PICTURE_IDS = [
  'build-out', 'high-press', 'drop-back', 'wing-defend', 'middle-defend', 'middle-attack', 'triangles',
];

const count = (s: string, needle: string): number => s.split(needle).length - 1;

afterEach(() => { vi.useRealTimers(); });

describe('training tab — markup and tab wiring', () => {
  it('adds the Training tab between Starting XI and Formations, and persists it', () => {
    const order = template.indexOf('id="tab-training"');
    expect(order).toBeGreaterThan(template.indexOf('id="tab-xi"'));
    expect(order).toBeLessThan(template.indexOf('id="tab-formations"'));
    expect(template).toContain('id="panel-training"');
    expect(template).toContain('4-2-3-1 &middot; team shape and practice plan');
    const h = runPage();
    expect(h.sandbox.TABS).toEqual(['roster', 'xi', 'training', 'formations', 'schedule', 'cuts']);
  });

  it('leaves the other tabs alone', () => {
    const h = runPage();
    expect(h.el('panel-training').hidden).toBe(true);
    expect(h.el('panel-roster').hidden).toBe(false);
    // Starting XI and the formation minis still render.
    expect(h.html('xi-pitch')).toContain('Antonio');
    expect(h.html('sched-calendar')).toContain('vs STEM');
  });
});

describe('training tab — the seven tactical pictures', () => {
  it('renders all seven cards, each with its first frame at rest', () => {
    const h = runPage();
    PICTURE_IDS.forEach((id, i) => {
      const card = h.card(id);
      expect(count(card, 'class="tp-lion'), `${id} lions`).toBe(11);
      expect(count(card, 'class="tp-ball"'), `${id} ball`).toBe(1);
      expect(count(card, 'class="tp-opp"'), `${id} opponents`).toBeGreaterThan(3);
      expect(card).toContain(`Picture ${i + 1} of 7`);
      expect(card).toContain(`id="tp-${id}-play"`);
      expect(card).toContain(`id="tp-${id}-dot-0"`);
      // Frame 1 caption is baked in, and frame 1 is current.
      const frames = h.sandbox.TACTICS.find((p) => p.id === id)!.frames;
      expect(card).toContain(frames[0]!.caption.slice(0, 40));
      expect(h.sandbox.TP_STATE[id]!.frame).toBe(0);
      expect(h.sandbox.TP_STATE[id]!.playing).toBe(false);
    });
  });

  it('draws a vertical pitch with our goal at the bottom and names every Lion', () => {
    const card = runPage().card('build-out');
    expect(card).toContain('viewBox="0 0 330 460"');
    expect(card).toContain('Our goal at the bottom');
    ['Antonio', 'George', 'Adham', 'Dickey', 'K. Martin', 'Adrian', 'Kiefer', 'Wit', 'Mat', 'Gabe', 'Caleb']
      .forEach((name) => expect(card).toContain(`>${name}</text>`));
    // Opponents carry no label.
    expect(count(card, '<g class="tp-opp"')).toBe(count(card, 'id="tp-build-out-opp-'));
  });

  it('shows the coaching points and the drill on every card', () => {
    const h = runPage();
    PICTURE_IDS.forEach((id) => {
      const card = h.card(id);
      const points = count(card, '<li>');
      expect(points, `${id} points`).toBeGreaterThanOrEqual(3);
      expect(points, `${id} points`).toBeLessThanOrEqual(5);
      expect(card).toContain('Practice it');
      expect(card).toContain('class="tp-drill-name"');
    });
    expect(h.card('build-out')).toContain('Box build-out 4v2 to target');
    expect(h.card('triangles')).toContain('Every player two passes from the ball');
  });

  it('steps frames with Next and Prev, updating the caption, count and dots', () => {
    const h = runPage();
    const frames = h.sandbox.TACTICS.find((p) => p.id === 'build-out')!.frames;
    const before = h.el('tp-build-out-lion-wit').getAttribute('transform');

    h.click('tp-build-out-next');
    expect(h.sandbox.TP_STATE['build-out']!.frame).toBe(1);
    expect(h.el('tp-build-out-cap').textContent).toBe(frames[1]!.caption);
    expect(h.el('tp-build-out-count').textContent).toBe('2 / 4');
    expect(h.el('tp-build-out-dot-1').getAttribute('aria-current')).toBe('true');
    expect(h.el('tp-build-out-dot-0').getAttribute('aria-current')).toBe('false');
    // Frame 2 is the first pass out, so the layer carries a dashed pass line.
    expect(h.el('tp-build-out-layer').innerHTML).toContain('class="tp-pass"');
    expect(h.el('tp-build-out-lion-wit').getAttribute('transform')).not.toBe(before);

    h.click('tp-build-out-prev');
    expect(h.sandbox.TP_STATE['build-out']!.frame).toBe(0);
    expect(h.el('tp-build-out-cap').textContent).toBe(frames[0]!.caption);
    expect(h.el('tp-build-out-count').textContent).toBe('1 / 4');

    // Prev from the first frame wraps to the last.
    h.click('tp-build-out-prev');
    expect(h.sandbox.TP_STATE['build-out']!.frame).toBe(frames.length - 1);
    expect(h.el('tp-build-out-count').textContent).toBe('4 / 4');
  });

  it('jumps to a frame from its dot', () => {
    const h = runPage();
    const frames = h.sandbox.TACTICS.find((p) => p.id === 'triangles')!.frames;
    h.click('tp-triangles-dot-2');
    expect(h.sandbox.TP_STATE['triangles']!.frame).toBe(2);
    expect(h.el('tp-triangles-cap').textContent).toBe(frames[2]!.caption);
    expect(h.el('tp-triangles-count').textContent).toBe('3 / 3');
    // The reformed triangles are translucent gold polygons.
    expect(count(h.el('tp-triangles-layer').innerHTML, 'class="tp-shape"')).toBe(3);
  });

  it('draws the bad straight line on the flat frame of the triangles picture', () => {
    expect(runPage().card('triangles')).toContain('class="tp-bad"');
  });

  it('auto-advances on Play, and only one card plays at a time', () => {
    vi.useFakeTimers();
    const h = runPage();

    h.click('tp-build-out-play');
    expect(h.sandbox.TP_STATE['build-out']!.playing).toBe(true);
    expect(h.el('tp-build-out-play').textContent).toBe('Pause');
    expect(h.el('tp-build-out-play').getAttribute('aria-pressed')).toBe('true');

    vi.advanceTimersByTime(2200);
    expect(h.sandbox.TP_STATE['build-out']!.frame).toBe(1);
    vi.advanceTimersByTime(2200);
    expect(h.sandbox.TP_STATE['build-out']!.frame).toBe(2);

    // Starting a second card stops the first.
    h.click('tp-high-press-play');
    expect(h.sandbox.TP_STATE['build-out']!.playing).toBe(false);
    expect(h.el('tp-build-out-play').textContent).toBe('Play');
    expect(h.sandbox.TP_STATE['high-press']!.playing).toBe(true);

    vi.advanceTimersByTime(2200);
    expect(h.sandbox.TP_STATE['high-press']!.frame).toBe(1);
    expect(h.sandbox.TP_STATE['build-out']!.frame).toBe(2);

    // Pause stops the clock.
    h.click('tp-high-press-play');
    vi.advanceTimersByTime(10000);
    expect(h.sandbox.TP_STATE['high-press']!.frame).toBe(1);
    expect(h.sandbox.TP_STATE['high-press']!.playing).toBe(false);
  });

  it('wraps back to the first frame while playing', () => {
    vi.useFakeTimers();
    const h = runPage();
    h.click('tp-drop-back-play');
    vi.advanceTimersByTime(2200 * 3);
    expect(h.sandbox.TP_STATE['drop-back']!.frame).toBe(0);
  });

  it('stops playback when another tab is opened', () => {
    vi.useFakeTimers();
    const h = runPage();
    h.click('tp-build-out-play');
    h.click('tab-formations');
    expect(h.sandbox.TP_STATE['build-out']!.playing).toBe(false);
    vi.advanceTimersByTime(5000);
    expect(h.sandbox.TP_STATE['build-out']!.frame).toBe(0);
  });

  it('honours prefers-reduced-motion: no auto-play, frames still step', () => {
    vi.useFakeTimers();
    const h = runPage({ reducedMotion: true });
    const card = h.card('build-out');
    expect(card).toContain('disabled');
    expect(card).toContain('Motion off');

    h.click('tp-build-out-play');
    expect(h.sandbox.TP_STATE['build-out']!.playing).toBe(false);
    vi.advanceTimersByTime(20000);
    expect(h.sandbox.TP_STATE['build-out']!.frame).toBe(0);

    h.click('tp-build-out-next');
    expect(h.sandbox.TP_STATE['build-out']!.frame).toBe(1);
    expect(h.el('tp-build-out-count').textContent).toBe('2 / 4');
  });
});

describe('training tab — goalkeeper session', () => {
  it('lists the four keeper stations', () => {
    const h = runPage();
    expect(template).toContain('Keepers train separately');
    expect(template).toContain('Antonio and Nicholas work with a coach or a parent server');
    const stations = h.html('gk-stations');
    expect(count(stations, 'class="gk-station"')).toBe(4);
    ['Distribution', 'Cutting angles', 'Closing down an attacker', 'Positioning when the ball is not in hand']
      .forEach((name) => expect(stations).toContain(name));
  });

  it('renders the keeper angles picture on a half pitch with the back four and one opponent', () => {
    const h = runPage();
    const card = h.card('gk-angles');
    expect(card).toContain('viewBox="0 0 330 268"');
    expect(count(card, 'class="tp-lion')).toBe(5);
    expect(count(card, 'class="tp-opp"')).toBe(1);
    expect(count(card, 'class="tp-ball"')).toBe(1);
    expect(card).toContain('tp-keeper');
    expect(card).toContain('Keeper angles and starting position');
    // Frame 1 has no cone; frames 2-4 draw one.
    expect(card).not.toContain('class="tp-cone"');
    h.click('tp-gk-angles-next');
    expect(h.el('tp-gk-angles-layer').innerHTML).toContain('class="tp-cone"');
    expect(h.el('tp-gk-angles-count').textContent).toBe('2 / 4');
  });
});

describe('training tab — coaching by player', () => {
  const focus = (n: number) => Array.from({ length: n }, (_v, i) => ({
    title: `Focus ${i + 1}`,
    why: `Why ${i + 1}`,
    cues: ['cue a', 'cue b'],
    drill: { name: `Drill ${i + 1}`, setup: 'setup line', reps: '3 x 5' },
    success: `success ${i + 1}`,
  }));

  it('ships the COACHING constant seeded empty', () => {
    expect(template).toContain('var COACHING = {};');
    expect(runPage().sandbox.COACHING).toEqual({});
  });

  it('renders the quiet placeholder for a player with no entry', () => {
    const h = runPage();
    expect(h.html('profile')).toContain('Coaching focus');
    expect(h.html('profile')).toContain('Coaching plan coming.');
    expect(h.html('profile')).not.toContain('class="cf-item"');
    // And on the training grid.
    expect(count(h.html('coach-by-player'), 'Coaching plan coming.')).toBe(23);
  });

  it('renders one accordion item per focus item with the first open', () => {
    const h = runPage();
    h.sandbox.COACHING['Kiefer'] = { position: 'CM', one_thing: 'Drive past the first man.', focus: focus(3) };
    h.sandbox.renderProfile();

    const profile = h.html('profile');
    expect(count(profile, 'class="cf-item"')).toBe(3);
    expect(profile).toContain('Drive past the first man.');
    expect(profile).toContain('id="cf-kiefer-0"');
    expect(profile).toContain('Drill 2');
    expect(profile).toContain('3 x 5');
    expect(profile).toContain('success 3');
    // First item open, the rest collapsed.
    expect(profile).toContain('id="cf-kiefer-0-body"><ul');
    expect(profile).toContain('id="cf-kiefer-1-body" hidden>');
  });

  it('renders four items for a keeper', () => {
    const h = runPage();
    h.sandbox.COACHING['Antonio De Marco'] = { position: 'GK', one_thing: 'Own the six.', focus: focus(4) };
    h.sandbox.state.player = 'antonio-de-marco';
    h.sandbox.renderProfile();
    expect(count(h.html('profile'), 'class="cf-item"')).toBe(4);
    expect(h.html('profile')).toContain('id="cf-antonio-de-marco-3"');
  });

  it('opens and closes an accordion item on click', () => {
    const h = runPage();
    h.sandbox.COACHING['Kiefer'] = { position: 'CM', one_thing: 'One thing.', focus: focus(3) };
    h.sandbox.renderProfile();

    h.click('cf-kiefer-2');
    expect(h.el('cf-kiefer-2-body').hidden).toBe(false);
    expect(h.el('cf-kiefer-2').getAttribute('aria-expanded')).toBe('true');
    expect(h.el('cf-kiefer-0-body').hidden).toBe(true);
    expect(h.el('cf-kiefer-0').getAttribute('aria-expanded')).toBe('false');

    // Clicking the open one collapses it.
    h.click('cf-kiefer-2');
    expect(h.el('cf-kiefer-2-body').hidden).toBe(true);
    expect(h.sandbox.COACH_OPEN['kiefer']).toBe(-1);
  });

  it('groups the training grid by line and lists the focus titles', () => {
    const h = runPage();
    h.sandbox.COACHING['Kiefer'] = { position: 'CM', one_thing: 'One thing.', focus: focus(3) };
    (h.sandbox['renderCoachGrid'] as () => void)();
    const grid = h.html('coach-by-player');
    ['GK &middot; 2', 'Defenders &middot; 9', 'Midfielders &middot; 6', 'Forwards &middot; 6']
      .forEach((label) => expect(grid).toContain(label));
    expect(count(grid, 'class="cbp"')).toBe(23);
    expect(grid).toContain('<li>Focus 1</li><li>Focus 2</li><li>Focus 3</li>');
  });

  it('opens the roster profile when a grid card is clicked', () => {
    const h = runPage();
    h.click('cbp-wit');
    expect(h.sandbox.state.tab).toBe('roster');
    expect(h.sandbox.state.player).toBe('wit');
    expect(h.el('panel-roster').hidden).toBe(false);
    expect(h.el('panel-training').hidden).toBe(true);
    expect(h.html('profile')).toContain('Wit');
  });
});

describe('training tab — eight-session practice plan', () => {
  it('has eight rows, each linking its tactical picture card', () => {
    const h = runPage();
    const rows = h.html('ses-rows');
    expect(count(rows, '<tr>')).toBe(8);
    expect(rows).toContain('href="#tp-triangles-card"');
    expect(rows).toContain('href="#tp-wing-defend-card"');
    expect(rows).toContain('href="#tp-gk-angles-card"');
    PICTURE_IDS.forEach((id) => expect(rows).toContain(`href="#tp-${id}-card"`));
  });

  it('states the 75-minute structure once', () => {
    expect(template).toContain('10 min rondo warm-up &middot; 20 min technique stations by position &middot; 25 min tactical picture &middot; 20 min game with a rule.');
    expect(template).toContain('Eight sessions over four weeks, 75 minutes each.');
  });
});
