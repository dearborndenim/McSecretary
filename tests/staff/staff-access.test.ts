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
import { toolsForUser, isToolAllowed, checkToolCall, PERSONAL_TOOLS, ADMIN_ONLY_TOOLS } from '../../src/staff/tool-policy.js';
import { graphSegment } from '../../src/auth/graph-base.js';
import { handleStaffAdminCommand } from '../../src/staff/admin-commands.js';

const member = { role: 'member' };
const admin = { role: 'admin' };
const OWN = ['olivier@dearborndenim.com'];

describe('toolsForUser (staff access spec §7.1)', () => {
  it("a member's tool list holds the personal tools and no admin-only tool", () => {
    const names = toolsForUser(member, TOOL_DEFINITIONS, OWN).map((t) => t.name).sort();
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
    expect(toolsForUser(admin, TOOL_DEFINITIONS, [])).toEqual(TOOL_DEFINITIONS);
  });

  it('an unknown tool name is admin-only (fail closed)', () => {
    expect(isToolAllowed(member, 'some_new_tool')).toBe(false);
    expect(isToolAllowed(admin, 'some_new_tool')).toBe(true);
    const extra = [...TOOL_DEFINITIONS, { name: 'some_new_tool', description: 'x', input_schema: { type: 'object' as const, properties: {} } }];
    expect(toolsForUser(member, extra, OWN).map((t) => t.name)).not.toContain('some_new_tool');
  });

  it("checkToolCall refuses a member's admin-only tool and another person's mailbox, never throws", () => {
    const own = ['olivier@dearborndenim.com'];
    expect(checkToolCall(member, 'update_schedule', {}, own)).toMatch(/not available/);
    expect(checkToolCall(member, 'send_email', { account: 'rob@dearborndenim.com' }, own)).toMatch(/own linked email/);
    expect(checkToolCall(member, 'send_email', { account: 42 }, own)).toMatch(/account value is not a valid id/);
    expect(checkToolCall(member, 'send_email', { account: 'Olivier@dearborndenim.com' }, own)).toBeNull();
    expect(checkToolCall(member, 'list_calendar_events', {}, own)).toBeNull();
    expect(checkToolCall(member, 'archive_email', null, own)).toBeNull();
    expect(checkToolCall(admin, 'send_email', { account: 'anyone@x.com' }, [])).toBeNull();
  });

  it('PERSONAL_TOOLS is disjoint from the admin-only, empire and graph tool names', () => {
    const others = new Set([
      ...ADMIN_ONLY_TOOLS,
      ...EMPIRE_TOOL_DEFINITIONS.map((t) => t.name),
      ...GRAPH_TOOL_DEFINITIONS.map((t) => t.name),
    ]);
    expect([...PERSONAL_TOOLS].filter((n) => others.has(n))).toEqual([]);
  });

  it('a member with no linked account sees no personal tools, only their staff tools', () => {
    expect(toolsForUser(member, TOOL_DEFINITIONS, [])).toEqual([]);
    const staff = [{ name: 'ops_note', description: 'x', input_schema: { type: 'object' as const, properties: {} } }];
    expect(toolsForUser(member, TOOL_DEFINITIONS, [], staff).map((t) => t.name)).toEqual(['ops_note']);
    // A staff action is callable only when it is in the caller's own set.
    expect(checkToolCall(member, 'ops_note', {}, [], new Set(['ops_note']))).toBeNull();
    expect(checkToolCall(member, 'store_inventory_set', {}, [], new Set(['ops_note']))).toMatch(/not available/);
  });

  it('refuses a path-traversal id into another mailbox; the URL segment encoder keeps it one segment', () => {
    const traversal = '../../rob@dearborndenim.com/messages/AAMkAD=';
    expect(checkToolCall(member, 'send_email', { account: OWN[0], reply_to_id: traversal, body: 'x' }, OWN))
      .toMatch(/reply_to_id value is not a valid id/);
    expect(checkToolCall(member, 'bulk_archive_emails', { account: OWN[0], email_ids: ['AAMkAD=', '../x'] }, OWN))
      .toMatch(/email_ids/);
    expect(checkToolCall(member, 'archive_email', { account: OWN[0], email_id: 'AAMkAGI2-_Tg=' }, OWN)).toBeNull();
    expect(graphSegment(traversal)).toBe('..%2F..%2Frob@dearborndenim.com%2Fmessages%2FAAMkAD=');
    expect(graphSegment('..')).toBe('%2E%2E');
  });

  it('a member with no linked account is refused every personal tool (the calendar would fall back to Robert)', () => {
    expect(checkToolCall(member, 'create_calendar_event', { subject: 's', start: 'a', end: 'b' }, []))
      .toBe('You have no linked email account yet, so email and calendar tools are off; ask Robert to link one.');
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
