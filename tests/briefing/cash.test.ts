/**
 * The `cash` briefing section against recorded quickbooks-sync payloads.
 *
 * Fixtures (tests/fixtures/quickbooks-sync/) follow the handlers on
 * quickbooks-sync `feat/finance-f4-planning` (PR #4) key for key.
 * `cash-forecast-floor-breach.json` is the live company-wide plan PR #4
 * published on 2026-10-01 (start $102,370.06, net -$25,605.04 a week,
 * $50,000 floor); the others reuse the published live figures where there
 * are any (cash total, 9/21 deposits) and are illustrative elsewhere (no loan
 * rows exist yet).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { buildCashSection, formatCashSection, parseCashForecast } from '../../src/briefing/cash.js';

const FIX = path.join(process.cwd(), 'tests', 'fixtures', 'quickbooks-sync');
const fixture = (name: string): unknown => JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8'));
const TODAY = '2026-10-01';
const ENV = { QUICKBOOKS_SYNC_URL: 'https://qbs.test', QUICKBOOKS_SYNC_KEY: 'test-bearer' };
const BRANDS_DIR = path.join(process.cwd(), 'config', 'brands');

type Routes = Record<string, unknown | number>;

/** A hand that answers each /api/integration path with a fixture body, or a bare status number. */
function hand(routes: Routes) {
  return async (url: string): Promise<Response> => {
    const r = routes[new URL(url).pathname];
    if (r === undefined) return new Response('{"detail":"Not Found"}', { status: 404 });
    if (typeof r === 'number') return new Response('{}', { status: r });
    return new Response(JSON.stringify(r), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

async function run(fetch: (url: string, init: RequestInit) => Promise<Response>, env: Record<string, string> = ENV) {
  const logs: string[] = [];
  const text = await buildCashSection({ brandsDir: BRANDS_DIR, env, fetch, today: TODAY, log: (m) => logs.push(m) });
  return { text, logs };
}

const NORMAL: Routes = {
  '/api/integration/cash-forecast': fixture('cash-forecast-normal.json'),
  '/api/integration/finance-week': fixture('finance-week.json'),
  '/api/integration/loans': fixture('loans.json'),
  '/api/integration/unassigned': fixture('unassigned.json'),
};

describe('cash briefing section', () => {
  it('normal week: six lines, last completed week, only loans due within 14 days', async () => {
    const { text, logs } = await run(hand(NORMAL));
    expect(text!.split('\n')).toEqual([
      'CASH (company-wide, from QuickBooks):',
      'Cash today: $102,370 in the bank.',
      '13-week low: $61,241 in the week of 11/23, $11,241 over the $50,000 floor.',
      'Last week (9/21): revenue $30,543, expenses $44,912.',
      'Debt service due by 10/15: $2,450 (Kabbage 10/5 $2,450).',
      'Unassigned transactions last week: 61 ($71,455), not yet classed in QuickBooks.',
    ]);
    expect(logs).toEqual([]);
  });

  it('floor breach within 4 weeks leads with URGENT (live plan of 2026-10-01); no loans, no debt line', async () => {
    const { text } = await run(hand({
      ...NORMAL,
      '/api/integration/cash-forecast': fixture('cash-forecast-floor-breach.json'),
      '/api/integration/loans': fixture('loans-empty.json'),
    }));
    const lines = text!.split('\n');
    expect(lines[1]).toBe('URGENT: cash falls below the $50,000 floor in the week of 10/12 ($25,555); '
      + '13-week low -$230,495 in the week of 12/21, $280,495 under the $50,000 floor.');
    expect(lines).toHaveLength(5);
    expect(text).not.toMatch(/Debt service/);
  });

  it('a floor breach more than 4 weeks out is reported without URGENT', () => {
    const live = parseCashForecast(fixture('cash-forecast-floor-breach.json'))!;
    // Same plan regenerated a month earlier: first breach (10/12) is 6 weeks out.
    const text = formatCashSection({ today: '2026-08-31', forecast: live })!;
    expect(text).not.toMatch(/URGENT/);
    expect(text).toContain('13-week low: -$230,495 in the week of 12/21, $280,495 under the $50,000 floor (first below it the week of 10/12).');
  });

  it('hand down or not configured: no section, one log line, no throw', async () => {
    const down = await run(async () => { throw new TypeError('fetch failed'); });
    expect(down.text).toBeNull();
    expect(down.logs).toEqual(['Skipping cash section: /api/integration/cash-forecast fetch failed']);

    const unset = await run(hand(NORMAL), {});
    expect(unset.text).toBeNull();
    expect(unset.logs).toHaveLength(1);
  });

  it('cash-forecast route missing (PR #4 not deployed): no section even though the other routes answer', async () => {
    const { ['/api/integration/cash-forecast']: _gone, ...older } = NORMAL;
    const { text, logs } = await run(hand(older));
    expect(text).toBeNull();
    expect(logs).toEqual(['Skipping cash section: /api/integration/cash-forecast 404']);
  });

  it('a failed optional read drops only its own line', async () => {
    const { text, logs } = await run(hand({ ...NORMAL, '/api/integration/loans': 500, '/api/integration/unassigned': 404 }));
    expect(text!.split('\n')).toHaveLength(4);
    expect(logs).toEqual(['Cash section without some lines: /api/integration/loans 500; /api/integration/unassigned 404']);
  });
});
