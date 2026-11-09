import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';

describe('initializeSchema', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('creates all required tables', () => {
    initializeSchema(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain('processed_emails');
    expect(tableNames).toContain('sender_profiles');
    expect(tableNames).toContain('agent_runs');
    expect(tableNames).toContain('audit_log');
  });

  it('is idempotent — running twice does not throw', () => {
    initializeSchema(db);
    expect(() => initializeSchema(db)).not.toThrow();
  });

  it('adds the inbox sweep tables to an existing database without touching its rows', () => {
    initializeSchema(db);
    db.exec(`DROP TABLE inbox_sweep_log; DROP TABLE inbox_sweep_state;`);
    db.prepare("INSERT INTO processed_emails (id, account, sender, category) VALUES ('m1', 'rob@dearborndenim.com', 'a@b.example', 'supplier')").run();
    db.prepare("INSERT INTO processed_emails (id, account, sender, category) VALUES ('m2', 'rob@dearborndenim.com', 'c@d.example', 'junk')").run();
    const before = (db.prepare('SELECT COUNT(*) AS n FROM processed_emails').get() as { n: number }).n;

    initializeSchema(db);

    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name);
    expect(names).toContain('inbox_sweep_state');
    expect(names).toContain('inbox_sweep_log');
    expect((db.prepare('SELECT COUNT(*) AS n FROM processed_emails').get() as { n: number }).n).toBe(before);
    expect(before).toBe(2);
  });
});
