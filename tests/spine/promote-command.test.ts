import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import { parsePromoteCommand, runPromoteCommand } from '../../src/spine/promote-command.js';
import { getTrustLevel } from '../../src/db/trust-queries.js';

const NOW = '2026-09-07T12:00:00.000Z';

describe('promote command', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); initializeSchema(db); });
  afterEach(() => db.close());

  it('parses "promote <agent> <action> <level>" with optional brand', () => {
    expect(parsePromoteCommand('promote marketing-manager creative_request 2')).toEqual({ agent: 'marketing-manager', action_type: 'creative_request', level: 2, brand_id: undefined });
    expect(parsePromoteCommand('promote finance x 3 brand=other')).toEqual({ agent: 'finance', action_type: 'x', level: 3, brand_id: 'other' });
    expect(parsePromoteCommand('promote finance x')).toBeNull();
    expect(parsePromoteCommand('hello')).toBeNull();
  });

  it('runs against the ledger and reports', () => {
    db.prepare("INSERT INTO users (id, name, email, role) VALUES ('robert','R','r@dd.com','admin')").run();
    const msg = runPromoteCommand(db, { agent: 'a', action_type: 'creative_request', level: 2, brand_id: undefined }, 'dearborn-denim', () => true, 'robert', NOW);
    expect(msg).toBe('a creative_request → level 2 (dearborn-denim).');
    expect(getTrustLevel(db, { agent: 'a', brand_id: 'dearborn-denim', action_type: 'creative_request' })).toBe(2);
  });

  it('refuses pinned actions with a reason', () => {
    db.prepare("INSERT INTO users (id, name, email, role) VALUES ('robert','R','r@dd.com','admin')").run();
    const msg = runPromoteCommand(db, { agent: 'a', action_type: 'ad_launch', level: 2, brand_id: undefined }, 'dearborn-denim', () => true, 'robert', NOW);
    expect(msg).toMatch(/pinned/);
  });

  it('refuses an unknown brand and writes nothing', () => {
    db.prepare("INSERT INTO users (id, name, email, role) VALUES ('robert','R','r@dd.com','admin')").run();
    const known = new Set(['dearborn-denim']);
    const msg = runPromoteCommand(db, { agent: 'a', action_type: 'x', level: 2, brand_id: 'nope' }, 'dearborn-denim', (id) => known.has(id), 'robert', NOW);
    expect(msg).toBe('Unknown brand: nope.');
    expect(db.prepare('SELECT COUNT(*) AS n FROM trust_ledger').get()).toEqual({ n: 0 });
  });

  it('only admins may promote; unknown users are refused too', () => {
    db.prepare("INSERT INTO users (id, name, email, role) VALUES ('m','M','m@dd.com','member')").run();
    expect(runPromoteCommand(db, { agent: 'a', action_type: 'x', level: 2, brand_id: undefined }, 'dearborn-denim', () => true, 'm', NOW)).toMatch(/admin/);
    expect(runPromoteCommand(db, { agent: 'a', action_type: 'x', level: 2, brand_id: undefined }, 'dearborn-denim', () => true, 'ghost', NOW)).toMatch(/admin/);
    expect(getTrustLevel(db, { agent: 'a', brand_id: 'dearborn-denim', action_type: 'x' })).toBe(1);
  });
});
