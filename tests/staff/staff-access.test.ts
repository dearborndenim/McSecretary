import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/config.js', () => ({
  config: {
    anthropic: { apiKey: 'test' },
    azure: { tenantId: 't', clientId: 'c', clientSecret: 's' },
    telegram: { botToken: 'x', chatId: '' },
    github: { token: 'test-token', org: 'test-org' },
    outlook: { email1: '' },
  },
}));
vi.mock('../../src/telegram/bot.js', () => ({
  sendMessage: vi.fn(),
  sendMessageToUser: vi.fn(),
  sendBriefingToUser: vi.fn(),
}));

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import { createUser, getUserById, getUserGrants } from '../../src/db/user-queries.js';
import { TOOL_DEFINITIONS } from '../../src/tools.js';
import { EMPIRE_TOOL_DEFINITIONS } from '../../src/empire/tools.js';
import { GRAPH_TOOL_DEFINITIONS } from '../../src/graph/tools.js';
import { toolsForUser, isToolAllowed, checkToolCall, PERSONAL_TOOLS } from '../../src/staff/tool-policy.js';
import { handleStaffAdminCommand } from '../../src/staff/admin-commands.js';

const member = { role: 'member' };
const admin = { role: 'admin' };

describe('toolsForUser (staff access spec §7.1)', () => {
  it("a member's tool list holds the personal tools and no admin-only tool", () => {
    const names = toolsForUser(member, TOOL_DEFINITIONS).map((t) => t.name).sort();
    expect(names).toEqual([...PERSONAL_TOOLS].sort());
    const adminOnly = [
      'update_schedule', 'toggle_schedule', 'view_schedule', 'check_journal_health',
      'create_todo_task', 'complete_todo_task', 'list_todo_tasks', 'get_completed_tasks',
      ...EMPIRE_TOOL_DEFINITIONS.map((t) => t.name),
      ...GRAPH_TOOL_DEFINITIONS.map((t) => t.name),
    ];
    for (const name of adminOnly) expect(names, name).not.toContain(name);
    expect(names).toContain('send_email');
    expect(names).toContain('list_calendar_events');
  });

  it('an admin gets the full list unchanged', () => {
    expect(toolsForUser(admin, TOOL_DEFINITIONS)).toBe(TOOL_DEFINITIONS);
  });

  it('an unknown tool name is admin-only (fail closed)', () => {
    expect(isToolAllowed(member, 'some_new_tool')).toBe(false);
    expect(isToolAllowed(admin, 'some_new_tool')).toBe(true);
    const extra = [...TOOL_DEFINITIONS, { name: 'some_new_tool', description: 'x', input_schema: { type: 'object' as const, properties: {} } }];
    expect(toolsForUser(member, extra).map((t) => t.name)).not.toContain('some_new_tool');
  });

  it("checkToolCall refuses a member's admin-only tool and another person's mailbox, never throws", () => {
    const own = ['olivier@dearborndenim.com'];
    expect(checkToolCall(member, 'update_schedule', {}, own)).toMatch(/not available/);
    expect(checkToolCall(member, 'send_email', { account: 'rob@dearborndenim.com' }, own)).toMatch(/own linked email/);
    expect(checkToolCall(member, 'send_email', { account: 42 }, own)).toMatch(/own linked email/);
    expect(checkToolCall(member, 'send_email', { account: 'Olivier@dearborndenim.com' }, own)).toBeNull();
    expect(checkToolCall(member, 'list_calendar_events', {}, own)).toBeNull();
    expect(checkToolCall(member, 'archive_email', null, own)).toBeNull();
    expect(checkToolCall(admin, 'send_email', { account: 'anyone@x.com' }, [])).toBeNull();
  });
});

describe('/grant (staff access spec §7.5)', () => {
  function setup() {
    const db = new Database(':memory:');
    initializeSchema(db);
    createUser(db, { id: 'kristina', name: 'Kristina', email: 'kristina@dearborndenim.com', role: 'member' });
    return db;
  }

  it('rejects an unknown group and leaves the grants untouched', () => {
    const db = setup();
    handleStaffAdminCommand(db, '/grant kristina@dearborndenim.com store', 'config/brands');
    const reply = handleStaffAdminCommand(db, '/grant kristina@dearborndenim.com store payroll', 'config/brands');
    expect(reply).toMatch(/Unknown group\(s\): payroll/);
    expect(getUserGrants(getUserById(db, 'kristina')!)).toEqual(['store']);
  });

  it('/setlocation store resolves the brand alias and errors when the alias is unset', () => {
    const db = setup();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brands-'));
    const brand = JSON.parse(fs.readFileSync('config/brands/dearborn-denim.json', 'utf8'));
    brand.store_location_id = 'gid://shopify/Location/5526519911';
    delete brand.location_id;
    fs.writeFileSync(path.join(dir, 'dearborn-denim.json'), JSON.stringify(brand));

    handleStaffAdminCommand(db, '/setlocation kristina@dearborndenim.com store', dir);
    expect(getUserById(db, 'kristina')!.location_id).toBe('gid://shopify/Location/5526519911');

    const reply = handleStaffAdminCommand(db, '/setlocation kristina@dearborndenim.com factory', dir);
    expect(reply).toMatch(/no location_id set/);
    expect(getUserById(db, 'kristina')!.location_id).toBe('gid://shopify/Location/5526519911');
  });
});
