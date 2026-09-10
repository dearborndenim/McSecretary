import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { lionsConfig, lionsCsvUrl } from '../../src/lions/config.js';

const index = fs.readFileSync(path.join(process.cwd(), 'src', 'index.ts'), 'utf8');
const api = fs.readFileSync(path.join(process.cwd(), 'src', 'api.ts'), 'utf8');
const schema = fs.readFileSync(path.join(process.cwd(), 'src', 'db', 'schema.ts'), 'utf8');

describe('lions wiring in src/index.ts', () => {
  it('registers both cron entries on the existing scheduler', () => {
    expect(index).toContain("{ name: 'Lions Schedule Check', schedule: '0 6,12,18 * * *', handler: handleLionsCheck");
    expect(index).toContain("{ name: 'Lions Schedule Check (Fri PM)', schedule: '0 20 * * 5', handler: handleLionsCheck");
    // Both entries go through initializeDefaultSchedule, which runs jobs in TIMEZONE (America/Chicago).
    const scheduleBlock = index.slice(index.indexOf('initializeDefaultSchedule(db, ['));
    expect(scheduleBlock.indexOf("name: 'Lions Schedule Check'")).toBeGreaterThan(-1);
  });

  it('mounts the router and passes the admin secret + a real check', () => {
    expect(index).toContain('setLionsHttpHandler(createLionsRouter({');
    expect(index).toContain('apiSecret: config.api.secret');
    expect(index).toContain('runCheck: () => runLionsCheck({ db })');
  });

  it('answers the /lions Telegram command for the admin', () => {
    expect(index).toContain("if (lowerText === '/lions' && user.role === 'admin')");
    expect(index).toContain('formatScheduleForTelegram(');
    expect(index).toContain('getActiveAlerts(db)');
  });

  it('handles a failed check without throwing out of the cron job', () => {
    const handler = index.slice(index.indexOf('async function handleLionsCheck'), index.indexOf('async function handleInviteReminders'));
    expect(handler).toContain('if (!result.ok)');
    expect(handler).toContain('console.error');
  });
});

describe('lions wiring in src/api.ts and src/db/schema.ts', () => {
  it('runs the lions handler before the legacy routes', () => {
    expect(api).toContain("if (_lionsHttp && (req.url ?? '').startsWith('/lions'))");
    expect(api.indexOf('_lionsHttp && ')).toBeLessThan(api.indexOf("req.url === '/health'"));
  });

  it('creates the lions tables with the other schemas', () => {
    expect(schema).toContain('initializeLionsSchema(db);');
  });
});

describe('lionsConfig', () => {
  it('defaults to the CPS Network 6 Crane HS tab and our team', () => {
    const cfg = lionsConfig({});
    expect(cfg).toMatchObject({
      sheetId: '1JHw7GN3iiXqzpEV0RxlYL4Uwk9e87jzRLJqCvC3g53A',
      gid: '974230082',
      team: 'SOUTH LOOP',
      venue: 'Crane HS',
      baseUrl: '',
    });
    expect(lionsCsvUrl(cfg)).toBe(
      'https://docs.google.com/spreadsheets/d/1JHw7GN3iiXqzpEV0RxlYL4Uwk9e87jzRLJqCvC3g53A/export?format=csv&gid=974230082',
    );
  });

  it('takes every value from the environment', () => {
    const cfg = lionsConfig({
      LIONS_SHEET_ID: 'sheet-2', LIONS_SHEET_GID: '11', LIONS_TEAM: 'south loop b',
      LIONS_VENUE: 'Hancock HS', LIONS_BASE_URL: 'https://mcsecretary.up.railway.app/',
    });
    expect(cfg).toMatchObject({
      sheetId: 'sheet-2', gid: '11', team: 'SOUTH LOOP B', venue: 'Hancock HS',
      baseUrl: 'https://mcsecretary.up.railway.app',
    });
    expect(lionsCsvUrl(cfg)).toBe('https://docs.google.com/spreadsheets/d/sheet-2/export?format=csv&gid=11');
  });

  it('falls back to BASE_URL and ignores blank values', () => {
    expect(lionsConfig({ BASE_URL: 'https://x.test' }).baseUrl).toBe('https://x.test');
    expect(lionsConfig({ LIONS_BASE_URL: '   ', BASE_URL: 'https://x.test' }).baseUrl).toBe('https://x.test');
    expect(lionsConfig({ LIONS_TEAM: '  ' }).team).toBe('SOUTH LOOP');
  });
});
