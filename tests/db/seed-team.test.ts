import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import { seedRobert } from '../../src/db/seed-robert.js';
import { seedTeam } from '../../src/db/seed-team.js';
import { getAllUsers, getUserEmailAccounts, getUserPreferences } from '../../src/db/user-queries.js';

describe('seed team', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
    seedRobert(db, '12345');
  });

  it('should create Olivier and Merab', () => {
    seedTeam(db);
    const users = getAllUsers(db);
    expect(users).toHaveLength(3); // Robert + Olivier + Merab
    expect(users.map((u) => u.name).sort()).toEqual(['Merab', 'Olivier', 'Robert McMillan']);
  });

  it('should set email accounts for each', () => {
    seedTeam(db);
    const users = getAllUsers(db);
    const olivier = users.find((u) => u.name === 'Olivier')!;
    const merab = users.find((u) => u.name === 'Merab')!;
    expect(getUserEmailAccounts(db, olivier.id)).toHaveLength(1);
    expect(getUserEmailAccounts(db, merab.id)).toHaveLength(1);
    expect(getUserEmailAccounts(db, olivier.id)[0]!.email_address).toBe('olivier@dearborndenim.com');
    expect(getUserEmailAccounts(db, merab.id)[0]!.email_address).toBe('merab@dearborndenim.com');
  });

  it('should set business context', () => {
    seedTeam(db);
    const users = getAllUsers(db);
    const olivier = users.find((u) => u.name === 'Olivier')!;
    const prefs = getUserPreferences(db, olivier.id);
    expect(prefs).toBeDefined();
    expect(prefs!.business_context).toBeTruthy();
  });

  it('should generate invite codes', () => {
    const { invites } = seedTeam(db);
    expect(invites).toHaveLength(2);
    expect(invites.map((i) => i.name).sort()).toEqual(['Merab', 'Olivier']);
    for (const inv of invites) {
      expect(inv.code).toBeTruthy();
    }
  });

  it('should be idempotent', () => {
    seedTeam(db);
    seedTeam(db);
    const users = getAllUsers(db);
    expect(users).toHaveLength(3);
  });

  it('should not generate new invites on second run', () => {
    const first = seedTeam(db);
    const second = seedTeam(db);
    expect(first.invites).toHaveLength(2);
    expect(second.invites).toHaveLength(0);
  });
});
