import { describe, it, expect } from 'vitest';
import {
  buildSystemPromptBase,
  buildActingOnRequests,
  buildStableSystemText,
  buildVolatileSystemText,
  buildChatSystemBlocks,
  type ChatPromptUser,
  type ChatContext,
} from '../src/chat-prompt.js';

const olivier: ChatPromptUser = {
  name: 'Olivier',
  business_context: 'Olivier works at Dearborn Denim. End user of kanban-purchaser.',
  accounts: ['olivier@dearborndenim.com'],
};

const robert: ChatPromptUser = {
  name: 'Robert',
  business_context:
    'Robert McMillan owns Dearborn Denim (rob@dearborndenim.com) and McMillan Manufacturing (robert@mcmillan-manufacturing.com).',
  accounts: ['rob@dearborndenim.com', 'robert@mcmillan-manufacturing.com'],
};

const ctx: ChatContext = {
  dailyContext: '\n\n=== WHAT I KNOW ===\nfacts',
  taskContext: '- Tasks: buy thread',
  smsContext: 'No texts.',
  emailContext: '1. ID: abc | Account: olivier@dearborndenim.com | Subject: Hi',
};

describe('buildSystemPromptBase (MCS-7 per-user)', () => {
  it('addresses the calling user, not Rob, and lists their own accounts', () => {
    const text = buildSystemPromptBase(olivier);
    expect(text).toContain("Olivier's AI chief of staff");
    expect(text).toContain("Olivier's email accounts: olivier@dearborndenim.com.");
    expect(text).toContain(olivier.business_context);
    expect(text).not.toMatch(/\bRob\b/);
    expect(text).not.toContain('rob@dearborndenim.com');
    expect(text).not.toContain('robert@mcmillan-manufacturing.com');
  });

  it('joins multiple accounts for Robert and keeps his business context verbatim', () => {
    const text = buildSystemPromptBase(robert);
    expect(text).toContain(
      "Robert's email accounts: rob@dearborndenim.com, robert@mcmillan-manufacturing.com.",
    );
    expect(text).toContain(robert.business_context);
  });

  it('falls back to a neutral team line when business_context is null or blank', () => {
    const nullCtx = buildSystemPromptBase({ ...olivier, business_context: null });
    const blankCtx = buildSystemPromptBase({ ...olivier, business_context: '   ' });
    expect(nullCtx).toContain('Olivier is on the Dearborn Denim team.');
    expect(blankCtx).toContain('Olivier is on the Dearborn Denim team.');
    expect(nullCtx).not.toContain('owns two businesses');
  });

  it('says so when no accounts are linked', () => {
    const text = buildSystemPromptBase({ ...olivier, accounts: [] });
    expect(text).toContain("Olivier's email accounts: (none linked yet).");
  });

  it('MCS-3: drops the prose tool catalog but keeps the SMS context block', () => {
    const text = buildSystemPromptBase(olivier);
    expect(text).not.toContain('=== YOUR TOOLS');
    expect(text).not.toContain('bulk_categorize_emails');
    expect(text).not.toContain('BULK OPERATION RULES');
    expect(text).not.toContain('PREFER THIS');
    expect(text).toContain('=== CAPABILITIES ===');
    expect(text).toContain('SMS/TEXT MESSAGES:');
    expect(text).toContain('You cannot send texts');
    expect(text).toContain('RECENT TEXT MESSAGES');
  });

  it('MCS-2: replaces the "NEVER say" prohibition with an honest-refusal instruction', () => {
    const text = buildSystemPromptBase(olivier);
    expect(text).not.toContain('NEVER say');
    expect(text).not.toContain('USE THEM');
    expect(text).toContain('say so plainly and offer the closest thing you can do');
  });

  it('MCS-10: no hardcoded job times; points at the schedule tools', () => {
    const text = buildSystemPromptBase(olivier);
    expect(text).toContain('=== YOUR SCHEDULED JOBS ===');
    expect(text).not.toContain('=== YOUR SCHEDULED TASKS ===');
    expect(text).not.toMatch(/\b4 AM\b/);
    expect(text).not.toMatch(/\b4 PM\b/);
    expect(text).not.toContain('Sunday 7 PM');
    expect(text).toContain('look them up with the schedule tools');
  });

  it('MCS-11: no longer advertises a "nightly plan" command', () => {
    expect(buildSystemPromptBase(olivier)).not.toMatch(/nightly plan/i);
  });

  it('MCS-1: the RULES section no longer carries the approval / act-immediately pair', () => {
    const text = buildSystemPromptBase(olivier);
    expect(text).not.toContain('ask Rob for approval first');
    expect(text).not.toContain('do it immediately, report what you did');
    expect(text).toContain("if an email isn't there, say so instead of guessing");
    // Kept on purpose (reasoned rules).
    expect(text).toContain('No emoji');
    expect(text).toContain('Central Time');
    expect(text).toContain('Apollo cold outreach');
  });
});

describe('buildActingOnRequests (MCS-1)', () => {
  it('states one consistent contract: act with tools, bulk in one call, approval only for send + calendar', () => {
    const text = buildActingOnRequests('Merab');
    expect(text.startsWith('ACTING ON REQUESTS:')).toBe(true);
    expect(text).toContain('When Merab asks for an action, do it with the tools');
    expect(text).toContain('bulk tools with all IDs in one call');
    expect(text).toContain('Archiving, tagging, and marking read need no confirmation');
    expect(text).toContain("Sending email and changing calendar events need Merab's explicit approval");
    expect(text).not.toContain('CRITICAL');
    expect(text).not.toContain('MUST');
    expect(text).not.toContain('act immediately');
  });
});

describe('buildChatSystemBlocks (MCS-9 cache layout)', () => {
  it('returns a stable block first and a volatile block second, both with ephemeral cache_control', () => {
    const blocks = buildChatSystemBlocks(olivier, ctx);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ type: 'text', cache_control: { type: 'ephemeral' } });
    expect(blocks[1]).toMatchObject({ type: 'text', cache_control: { type: 'ephemeral' } });
    expect(blocks[0]!.text).toBe(buildStableSystemText(olivier));
    expect(blocks[1]!.text).toBe(buildVolatileSystemText(ctx));
  });

  it('stable block = base + acting contract and contains nothing from the volatile context', () => {
    const [stable] = buildChatSystemBlocks(olivier, ctx);
    expect(stable!.text).toContain('ACTING ON REQUESTS:');
    expect(stable!.text).toContain("Olivier's AI chief of staff");
    expect(stable!.text).not.toContain('buy thread');
    expect(stable!.text).not.toContain('ID: abc');
    expect(stable!.text).not.toContain('WHAT I KNOW');
  });

  it('stable block is byte-identical across requests when only the volatile context changes', () => {
    const a = buildChatSystemBlocks(olivier, ctx)[0]!.text;
    const b = buildChatSystemBlocks(olivier, {
      ...ctx,
      emailContext: 'different emails',
      smsContext: 'different texts',
      taskContext: 'different tasks',
      dailyContext: 'different daily',
    })[0]!.text;
    expect(a).toBe(b);
  });

  it('volatile block carries the four context sections in the original order', () => {
    const [, volatile] = buildChatSystemBlocks(olivier, ctx);
    const t = volatile!.text;
    const iDaily = t.indexOf('WHAT I KNOW');
    const iTasks = t.indexOf('MICROSOFT TO DO TASKS:\n- Tasks: buy thread');
    const iSms = t.indexOf('RECENT TEXT MESSAGES (last 24 hours):\nNo texts.');
    const iEmail = t.indexOf('RECENT EMAILS (last 48 hours):\n1. ID: abc');
    expect(iDaily).toBeGreaterThanOrEqual(0);
    expect(iTasks).toBeGreaterThan(iDaily);
    expect(iSms).toBeGreaterThan(iTasks);
    expect(iEmail).toBeGreaterThan(iSms);
  });
});

// ---------- read-only / no-execution policy (Robert, 2026-09-10) ----------

describe('hard-limits policy: no code execution, no GitHub writes, no build queue', () => {
  it('states all three prohibitions plainly', () => {
    const text = buildSystemPromptBase(robert);
    expect(text).toContain('=== WHAT YOU DO NOT DO (HARD LIMITS) ===');
    expect(text).toContain(
      'You never run code, never write to GitHub, and never queue work for a build system.',
    );
  });

  it('routes builds, code changes, and filed feedback to the Foreman session with a drafted message', () => {
    const text = buildSystemPromptBase(robert);
    expect(text).toContain('a build, a code change, a bug fix, feedback to be filed');
    expect(text).toContain('do not attempt a tool');
    expect(text).toContain('goes to the Foreman session (Claude Code)');
    expect(text).toContain('offer to draft the exact message to paste there');
  });

  it('tells the agent to relay the missing-token sentence once and not retry', () => {
    const text = buildSystemPromptBase(robert);
    expect(text).toContain('GITHUB_TOKEN is missing');
    expect(text).toContain('relay that sentence once');
    expect(text).toContain('do not retry it or try another tool');
  });

  it('still permits the two read tools by name', () => {
    const text = buildSystemPromptBase(robert);
    expect(text).toContain('read_project_status and list_projects are read-only');
  });

  it('advertises GitHub as read-only and drops the feedback-filing command', () => {
    const text = buildSystemPromptBase(robert);
    expect(text).toContain('READ-ONLY access to the dearborndenim GitHub org');
    expect(text).not.toContain('append feedback');
    expect(text).not.toContain('feedback [project]');
    expect(text).not.toContain('NIGHTLY_PLAN');
  });

  it('carries the policy into the cached stable block for every user', () => {
    for (const user of [robert, olivier]) {
      expect(buildStableSystemText(user), user.name).toContain('=== WHAT YOU DO NOT DO (HARD LIMITS) ===');
    }
  });
});
