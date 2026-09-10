import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { injectLionsData, lionsPagePath, loadLionsPageTemplate } from '../../src/lions/page.js';
import type { LionsGame } from '../../src/lions/parse.js';
import type { LionsAlertRow } from '../../src/lions/store.js';

const template = loadLionsPageTemplate();

const game: LionsGame = {
  week: 5, date: '2026-10-17', time: '2:00 PM', home: 'SOUTH LOOP', away: 'SKINNER',
  opponent: 'SKINNER', isHome: true, venue: 'Crane HS',
};

const alert: LionsAlertRow = {
  id: 12, created_at: '2026-09-09T23:00:00.000Z', week: 5, opponent: 'SKINNER',
  kind: 'time_changed', summary: 'Week 5 vs Skinner: 1:00 PM → 2:00 PM',
  before: '1:00 PM', after: '2:00 PM', cleared_at: null,
};

describe('lions page template', () => {
  it('is shipped inside src/lions and readable at runtime', () => {
    expect(lionsPagePath().endsWith('page.html')).toBe(true);
    expect(fs.existsSync(lionsPagePath())).toBe(true);
  });

  it('carries an empty data block so the file also works as a static artifact', () => {
    expect(template).toContain('<script id="lions-data" type="application/json">{"games":[],"alerts":[],"checkedAt":null,"live":false}</script>');
    expect(template).toContain('var SCHEDULE = [');
    expect(template).toContain('{ date:"2026-09-19", time:"2:00 PM", kind:"game"');
  });

  it('has the red alert banner, its token, the close button and the CHANGED pill', () => {
    expect(template).toContain('--alert:#C8352B;');
    expect(template).toContain('id="alert-banner"');
    expect(template).toContain('>SCHEDULE CHANGE<');
    expect(template).toContain('id="alert-close"');
    expect(template).toContain('Close</button>');
    expect(template).toContain('.pill-changed{');
    expect(template).toContain('pill pill-changed');
    // The banner sits above the sticky topbar (z-index 30) on every tab.
    expect(/\.alert-banner\{[^}]*position:fixed/.test(template)).toBe(true);
    expect(/@media \(prefers-reduced-motion:reduce\)\{ \.alert-banner\{ animation:none; \} \}/.test(template)).toBe(true);
  });

  it('reads the data block at boot, swaps in live games and remembers dismissals', () => {
    expect(template).toContain('document.getElementById("lions-data")');
    expect(template).toContain('function applyLiveSchedule()');
    expect(template).toContain('applyLiveSchedule();');
    expect(template).toContain('renderAlerts();');
    expect(template).toContain('ALERT_STORE_KEY = "slLionsAlertsSeen"');
    expect(template).toContain('localStorage.getItem(ALERT_STORE_KEY)');
    // Kicks and open-house rows survive so conflict detection keeps working.
    expect(template).toContain('SCHEDULE.filter(function(r){ return r.kind !== "game"; }).concat(live, keepTbd)');
    expect(template).toContain('Checked ');
  });
});

describe('injectLionsData', () => {
  it('replaces only the JSON inside the data block', () => {
    const out = injectLionsData(template, { games: [game], alerts: [alert], checkedAt: '2026-09-09T23:00:00.000Z', live: true });
    const block = /<script id="lions-data" type="application\/json">([\s\S]*?)<\/script>/.exec(out)!;
    const data = JSON.parse(block[1]!) as { games: LionsGame[]; alerts: LionsAlertRow[]; live: boolean };
    expect(data.games).toEqual([game]);
    expect(data.alerts[0]!.summary).toBe('Week 5 vs Skinner: 1:00 PM → 2:00 PM');
    expect(data.live).toBe(true);
    // Everything else is byte-identical.
    expect(out.replace(block[0], '')).toBe(template.replace(/<script id="lions-data" type="application\/json">[\s\S]*?<\/script>/, ''));
  });

  it('escapes "</" anywhere in the payload', () => {
    const out = injectLionsData(template, {
      games: [{ ...game, notes: 'see </script><img src=x onerror=alert(1)>' }],
      alerts: [{ ...alert, summary: 'closing </script> tag' }],
      checkedAt: null,
      live: true,
    });
    const json = /<script id="lions-data" type="application\/json">([\s\S]*?)<\/script>/.exec(out)![1]!;
    expect(json).not.toContain('</script>');
    expect(json.match(/<\\\/script>/g)).toHaveLength(2);
    expect((JSON.parse(json) as { alerts: LionsAlertRow[] }).alerts[0]!.summary).toBe('closing </script> tag');
  });

  it('throws rather than serving an un-injected page when the block is gone', () => {
    expect(() => injectLionsData('<html>no block</html>', { games: [], alerts: [], checkedAt: null, live: false }))
      .toThrow(/lions-data/);
  });

  it('is stable across repeated injections', () => {
    const once = injectLionsData(template, { games: [game], alerts: [], checkedAt: null, live: true });
    const twice = injectLionsData(once, { games: [game], alerts: [], checkedAt: null, live: true });
    expect(twice).toBe(once);
  });
});
