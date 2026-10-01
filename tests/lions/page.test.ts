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
