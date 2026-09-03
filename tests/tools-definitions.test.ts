import { describe, it, expect } from 'vitest';
import { vi } from 'vitest';

vi.mock('../src/config.js', () => ({
  config: {
    anthropic: { apiKey: 'test' },
    azure: { tenantId: 't', clientId: 'c', clientSecret: 's' },
    telegram: { botToken: 'x', chatId: '' },
    github: { token: 'test-token', org: 'test-org' },
    outlook: { email1: '', email2: '' },
  },
}));
vi.mock('../src/telegram/bot.js', () => ({
  sendMessage: vi.fn(),
  sendMessageToUser: vi.fn(),
  sendBriefingToUser: vi.fn(),
}));

import { TOOL_DEFINITIONS } from '../src/tools.js';

type Tool = (typeof TOOL_DEFINITIONS)[number];
type Props = Record<string, { description?: string }>;

function tool(name: string): Tool {
  const t = TOOL_DEFINITIONS.find((d) => d.name === name);
  if (!t) throw new Error(`tool ${name} not defined`);
  return t;
}
function props(name: string): Props {
  return (tool(name).input_schema as { properties: Props }).properties;
}
function accountDesc(name: string): string {
  return props(name).account?.description ?? '';
}

const REQUIRED_ACCOUNT_TOOLS = [
  'archive_email',
  'categorize_email',
  'mark_email_read',
  'send_email',
  'bulk_archive_emails',
  'bulk_categorize_emails',
];
const FIRST_ACCOUNT_TOOLS = [
  'read_contacts',
  'list_email_categories',
  'create_email_category',
  'create_calendar_event',
  'update_calendar_event',
  'delete_calendar_event',
];
const ALL_ACCOUNTS_TOOLS = ['archive_emails_by_category', 'list_calendar_events'];

describe('MCS-8: account parameter descriptions', () => {
  it("no tool description or parameter names Rob's mailboxes", () => {
    for (const t of TOOL_DEFINITIONS) {
      const blob = JSON.stringify(t);
      expect(blob, t.name).not.toContain('rob@dearborndenim.com');
      expect(blob, t.name).not.toContain('robert@mcmillan-manufacturing.com');
    }
  });

  it('required-account tools point the model at the Account: value in RECENT EMAILS', () => {
    for (const name of REQUIRED_ACCOUNT_TOOLS) {
      const required = (tool(name).input_schema as { required: string[] }).required;
      expect(required, name).toContain('account');
      expect(accountDesc(name), name).toContain("calling user's linked email addresses");
      expect(accountDesc(name), name).toContain('RECENT EMAILS');
    }
  });

  it('first-linked-account tools state that default (matches resolveDefaultAccount)', () => {
    for (const name of FIRST_ACCOUNT_TOOLS) {
      const required = (tool(name).input_schema as { required: string[] }).required;
      expect(required, name).not.toContain('account');
      expect(accountDesc(name), name).toMatch(/^Optional\./);
      expect(accountDesc(name), name).toContain("user's first linked account");
    }
  });

  it('all-accounts tools state that default (matches resolveAccounts)', () => {
    for (const name of ALL_ACCOUNTS_TOOLS) {
      expect(accountDesc(name), name).toMatch(/^Optional\./);
      expect(accountDesc(name), name).toContain("all of the user's linked accounts");
    }
  });

  it('every tool with an account parameter is covered by one of the three groups', () => {
    const withAccount = TOOL_DEFINITIONS.filter((t) => 'account' in ((t.input_schema as { properties: Props }).properties ?? {})).map((t) => t.name);
    expect(withAccount.sort()).toEqual([...REQUIRED_ACCOUNT_TOOLS, ...FIRST_ACCOUNT_TOOLS, ...ALL_ACCOUNTS_TOOLS].sort());
  });
});

describe('MCS-12: send_email description', () => {
  const d = tool('send_email').description ?? '';
  it('states the approval gate as a contract with its reason', () => {
    expect(d).toContain('irreversible');
    expect(d).toContain('approved the exact recipient, subject, and body in this conversation');
    expect(d).not.toContain('ALWAYS');
    expect(d).not.toMatch(/\bRob\b/);
  });
  it('documents reply threading and the return value', () => {
    expect(d).toContain('reply_to_id');
    expect(d).toContain('subject is ignored');
    expect(d).toContain('Returns a confirmation string or the Graph error');
  });
});

describe('MCS-13: previously under-described tools', () => {
  it('mark_email_read says what it does not do', () => {
    expect(tool('mark_email_read').description).toContain('without moving or tagging it');
  });

  it('complete_todo_task documents substring matching and the list-creation side effect', () => {
    const d = tool('complete_todo_task').description ?? '';
    expect(d).toContain('substring');
    expect(d).toContain('first match is completed');
    expect(d).toContain('creates a new empty list');
    expect(props('complete_todo_task').task_title?.description).toContain('substring');
  });

  it('list_todo_tasks warns that a nonexistent list_name creates a list', () => {
    const d = tool('list_todo_tasks').description ?? '';
    expect(d).toContain('creates an empty list');
    expect(d).toContain('MICROSOFT TO DO TASKS');
  });

  it('update_schedule and toggle_schedule defer the job-name set to view_schedule instead of a hardcoded list', () => {
    for (const name of ['update_schedule', 'toggle_schedule']) {
      const d = props(name).task_name?.description ?? '';
      expect(d, name).toContain('view_schedule');
      expect(d, name).toContain('unknown names are rejected');
      expect(d, name).not.toContain('or "Weekly Synthesis"');
    }
    expect(tool('toggle_schedule').description).toContain('view_schedule first');
  });

  it('view_schedule and check_journal_health describe their output', () => {
    const v = tool('view_schedule').description ?? '';
    expect(v).toContain('cron expression');
    expect(v).toContain('Use before update_schedule or toggle_schedule');
    const j = tool('check_journal_health').description ?? '';
    expect(j).toContain('last 7 days');
    expect(j).toContain('next weekly synthesis date');
    expect(j).toContain('Read-only');
  });
});
