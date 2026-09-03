import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import { initializeSchema } from '../../src/db/schema.js';
import { buildSpine } from '../../src/spine/wiring.js';
import type { InboxTransport } from '../../src/spine/telegram-card.js';
import { getProposalById } from '../../src/db/proposal-queries.js';
import type { ProposalInput } from '../../src/spine/types.js';

const NOW = '2026-09-07T12:00:00.000Z';
const BRANDS = path.join(process.cwd(), 'config', 'brands');

function fakeBot(): InboxTransport & { sent: { chatId: string; text: string; hasKeyboard: boolean }[] } {
  const sent: { chatId: string; text: string; hasKeyboard: boolean }[] = [];
  return {
    sent,
    async sendCard(chatId, text) { sent.push({ chatId, text, hasKeyboard: true }); return { message_id: sent.length }; },
    async sendText(chatId, text) { sent.push({ chatId, text, hasKeyboard: false }); },
  };
}

function input(over: Partial<ProposalInput> = {}): ProposalInput {
  return {
    agent: 'marketing-manager', brand_id: 'dearborn-denim', action_type: 'creative_request',
    action_payload: { hand: 'content-engine', method: 'POST', path: '/api/briefs', body: { angle: 'fit' } },
    reason: 'r', evidence: { a: 1 }, cost_usd: 0, reversible: true, level_required: 1, expires_at: '2026-09-09T00:00:00.000Z',
    ...over,
  };
}

describe('buildSpine', () => {
  let db: Database.Database;
  let bot: ReturnType<typeof fakeBot>;
  let spine: ReturnType<typeof buildSpine>;
  beforeEach(() => {
    db = new Database(':memory:'); initializeSchema(db);
    db.prepare("INSERT INTO users (id, name, email, role, telegram_chat_id) VALUES ('robert-mcmillan','Robert','r@dd.com','admin','555')").run();
    bot = fakeBot();
    spine = buildSpine({ db, transport: bot, now: () => NOW, env: {}, brandsDir: BRANDS, agentKeys: new Map(), fetch: async () => new Response('{}') });
  });
  afterEach(() => db.close());

  it('files a proposal as a card to the brand inbox user', async () => {
    const r = await spine.file(input());
    expect(r.routed).toBe('card');
    expect(bot.sent[0]!.chatId).toBe('555');
    expect(bot.sent[0]!.hasKeyboard).toBe(true);
    expect(getProposalById(db, r.id)!.telegram_message_id).toBe(1);
  });

  it('onCallback rejects through the card handler and replies in the chat', async () => {
    const r = await spine.file(input({ action_type: 'noop' }));
    const out = await spine.onCallback(`prop:reject:${r.id}`, '555', 'robert-mcmillan');
    expect(out).toMatch(/rejected/i);
    expect(getProposalById(db, r.id)!.status).toBe('rejected');
    expect(bot.sent.at(-1)!.text).toMatch(/Rejected/);
  });

  it('onCallback from another chat is refused', async () => {
    const r = await spine.file(input({ action_type: 'noop' }));
    const out = await spine.onCallback(`prop:approve:${r.id}`, '999', 'someone');
    expect(out).toMatch(/not your proposal/i);
    expect(getProposalById(db, r.id)!.status).toBe('pending');
  });

  it('onCallback with garbage data returns a toast and writes nothing', async () => {
    expect(await spine.onCallback('prop:nuke:1', '555', 'robert-mcmillan')).toMatch(/unknown/i);
  });

  it('onText consumes an edit reply and otherwise returns false', async () => {
    expect(await spine.onText('555', 'hello', 'robert-mcmillan')).toBe(false);
    const r = await spine.file(input({ action_type: 'noop' }));
    await spine.onCallback(`prop:edit:${r.id}`, '555', 'robert-mcmillan');
    expect(await spine.onText('555', 'angle=durability', 'robert-mcmillan')).toBe(true);
    expect(JSON.parse(getProposalById(db, r.id)!.action_payload).body.angle).toBe('durability');
  });

  it('onText runs a promote command and replies', async () => {
    expect(await spine.onText('555', 'promote marketing-manager creative_request 2', 'robert-mcmillan')).toBe(true);
    expect(bot.sent.at(-1)!.text).toMatch(/level 2/);
  });

  it('a level-2 auto-execution reports to the inbox user', async () => {
    db.prepare("INSERT INTO trust_ledger (agent, brand_id, action_type, level) VALUES ('marketing-manager','dearborn-denim','creative_request',2)").run();
    const s = buildSpine({ db, transport: bot, now: () => NOW, env: { CONTENT_ENGINE_URL: 'https://ce.example', CONTENT_ENGINE_KEY: 'k' }, brandsDir: BRANDS, agentKeys: new Map(), fetch: async () => new Response('{"ok":true}', { status: 200 }) });
    const r = await s.file(input());
    expect(r.routed).toBe('executed');
    expect(bot.sent.at(-1)!.text).toMatch(/Executed #\d+/);
    expect(bot.sent.at(-1)!.hasKeyboard).toBe(false);
  });

  it('handleHttp answers /spine/* with the agent key map', async () => {
    const s = buildSpine({ db, transport: bot, now: () => NOW, env: {}, brandsDir: BRANDS, agentKeys: new Map([['k'.repeat(24), 'finance']]), fetch: async () => new Response('{}') });
    expect(typeof s.handleHttp).toBe('function');
  });
});
