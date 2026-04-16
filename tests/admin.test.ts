import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../src/db/schema.js';
import { parseAdminCommand, executeAdminCommand } from '../src/admin.js';
import { getAllUsers, getUserEmailAccounts } from '../src/db/user-queries.js';

describe('admin CLI', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
  });

  describe('parseAdminCommand', () => {
    it('should parse add-user command', () => {
      const cmd = parseAdminCommand(['add-user', '--name', 'Olivier', '--email', 'olivier@dd.com', '--role', 'member']);
      expect(cmd.action).toBe('add-user');
      expect(cmd.args.name).toBe('Olivier');
      expect(cmd.args.email).toBe('olivier@dd.com');
      expect(cmd.args.role).toBe('member');
    });

    it('should parse add-email command', () => {
      const cmd = parseAdminCommand(['add-email', '--user-id', 'u1', '--email', 'test@dd.com', '--provider', 'outlook']);
      expect(cmd.action).toBe('add-email');
      expect(cmd.args['user-id']).toBe('u1');
      expect(cmd.args.email).toBe('test@dd.com');
    });

    it('should parse list-users command', () => {
      const cmd = parseAdminCommand(['list-users']);
      expect(cmd.action).toBe('list-users');
      expect(cmd.args).toEqual({});
    });

    it('should parse generate-invite command', () => {
      const cmd = parseAdminCommand(['generate-invite', '--user-id', 'u1']);
      expect(cmd.action).toBe('generate-invite');
      expect(cmd.args['user-id']).toBe('u1');
    });

    it('should parse set-preferences command', () => {
      const cmd = parseAdminCommand(['set-preferences', '--user-id', 'u1', '--business-context', 'Runs ops']);
      expect(cmd.action).toBe('set-preferences');
      expect(cmd.args['business-context']).toBe('Runs ops');
    });
  });

  describe('executeAdminCommand', () => {
    it('should create user and generate invite', async () => {
      const result = await executeAdminCommand(db, {
        action: 'add-user',
        args: { name: 'Olivier', email: 'olivier@dd.com', role: 'member' },
      });
      expect(result).toContain('Created user');
      expect(result).toContain('Invite code:');

      const users = getAllUsers(db);
      expect(users).toHaveLength(1);
      expect(users[0]!.name).toBe('Olivier');
      expect(users[0]!.role).toBe('member');
    });

    it('should add email account', async () => {
      await executeAdminCommand(db, {
        action: 'add-user',
        args: { name: 'Olivier', email: 'olivier@dd.com', role: 'member' },
      });
      const users = getAllUsers(db);
      const olivier = users.find((u) => u.email === 'olivier@dd.com');

      const result = await executeAdminCommand(db, {
        action: 'add-email',
        args: { 'user-id': olivier!.id, email: 'olivier@dd.com', provider: 'outlook' },
      });
      expect(result).toContain('Email account added');

      const accounts = getUserEmailAccounts(db, olivier!.id);
      expect(accounts).toHaveLength(1);
      expect(accounts[0]!.email_address).toBe('olivier@dd.com');
    });

    it('should list users', async () => {
      await executeAdminCommand(db, { action: 'add-user', args: { name: 'Olivier', email: 'o@dd.com', role: 'member' } });
      await executeAdminCommand(db, { action: 'add-user', args: { name: 'Merab', email: 'm@dd.com', role: 'member' } });
      const result = await executeAdminCommand(db, { action: 'list-users', args: {} });
      expect(result).toContain('Olivier');
      expect(result).toContain('Merab');
    });

    it('should return no users message when empty', async () => {
      const result = await executeAdminCommand(db, { action: 'list-users', args: {} });
      expect(result).toBe('No users.');
    });

    it('should set preferences', async () => {
      await executeAdminCommand(db, {
        action: 'add-user',
        args: { name: 'Olivier', email: 'o@dd.com', role: 'member' },
      });
      const users = getAllUsers(db);
      const result = await executeAdminCommand(db, {
        action: 'set-preferences',
        args: { 'user-id': users[0]!.id, 'business-context': 'Manages ops at DD' },
      });
      expect(result).toContain('Preferences updated');
    });

    it('should generate invite', async () => {
      await executeAdminCommand(db, {
        action: 'add-user',
        args: { name: 'Olivier', email: 'o@dd.com', role: 'member' },
      });
      const users = getAllUsers(db);
      const result = await executeAdminCommand(db, {
        action: 'generate-invite',
        args: { 'user-id': users[0]!.id },
      });
      expect(result).toContain('Invite code:');
      expect(result).toContain('Expires in 24 hours');
    });

    it('should report unknown command', async () => {
      const result = await executeAdminCommand(db, { action: 'unknown-cmd', args: {} });
      expect(result).toContain('Unknown command: unknown-cmd');
      expect(result).toContain('Available:');
    });
  });
});
