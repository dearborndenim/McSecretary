import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const index = fs.readFileSync(path.join(process.cwd(), 'src', 'index.ts'), 'utf8');
const api = fs.readFileSync(path.join(process.cwd(), 'src', 'api.ts'), 'utf8');

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

});

describe('lions wiring in src/api.ts and src/db/schema.ts', () => {
  it('runs the lions handler before the legacy routes', () => {
    expect(api).toContain("if (_lionsHttp && (req.url ?? '').startsWith('/lions'))");
    expect(api.indexOf('_lionsHttp && ')).toBeLessThan(api.indexOf("req.url === '/health'"));
  });

});
