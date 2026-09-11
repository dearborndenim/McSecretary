import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
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

type FakeReq = import('node:http').IncomingMessage;

function fakeReq(method: string, url: string, body?: unknown, auth?: string): FakeReq {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const listeners: Record<string, ((...a: unknown[]) => void)[]> = {};
  const req = {
    method, url, headers: auth ? { authorization: auth } : {},
    on(ev: string, fn: (...a: unknown[]) => void) { (listeners[ev] ??= []).push(fn); return req; },
    destroy() { return req; },
    pause() { return req; },
  };
  queueMicrotask(() => { for (const c of chunks) listeners.data?.forEach((f) => f(c)); listeners.end?.forEach((f) => f()); });
  return req as unknown as FakeReq;
}

function fakeRes() {
  const out = { status: 0, body: '' };
  const res = {
    writeHead(s: number) { out.status = s; return res; },
    end(b?: string, cb?: () => void) { out.body = b ?? ''; cb?.(); },
  };
  return { res: res as unknown as import('node:http').ServerResponse, out };
}

/** A hand that never answers: resolves only by rejecting when the signal aborts. */
function hungFetch(): (url: string, init: RequestInit) => Promise<Response> {
  return (_url, init) => new Promise<Response>((_resolve, reject) => {
    const signal = init.signal;
    if (!signal) return;
    if (signal.aborted) { reject(signal.reason); return; }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
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

  it('a level-2 auto-execution still reports executed when the inbox user has no chat', async () => {
    db.prepare("INSERT INTO trust_ledger (agent, brand_id, action_type, level) VALUES ('marketing-manager','dearborn-denim','creative_request',2)").run();
    db.prepare("UPDATE users SET telegram_chat_id = NULL WHERE id = 'robert-mcmillan'").run();
    const s = buildSpine({ db, transport: bot, now: () => NOW, env: { CONTENT_ENGINE_URL: 'https://ce.example', CONTENT_ENGINE_KEY: 'k' }, brandsDir: BRANDS, agentKeys: new Map(), fetch: async () => new Response('{"ok":true}', { status: 200 }) });
    const r = await s.file(input());
    expect(r.routed).toBe('executed');
    expect(getProposalById(db, r.id)!.status).toBe('executed');
    expect(bot.sent).toHaveLength(0);
  });

  it('wires the built-in email hand through Graph and records rfq_messages', async () => {
    db.prepare("INSERT INTO trust_ledger (agent, brand_id, action_type, level) VALUES ('sourcing','dearborn-denim','rfq_send',2)").run();
    const calls: string[] = [];
    const s = buildSpine({
      db, transport: bot, now: () => NOW, env: { RFQ_FROM_ADDRESS: 'rob@dearborndenim.com' },
      brandsDir: BRANDS, agentKeys: new Map(),
      fetch: async (url) => { calls.push(url); return new Response('', { status: 202, headers: { 'request-id': 'g-7' } }); },
      getGraphToken: async () => 'tok',
    });
    const r = await s.file(input({
      agent: 'sourcing', action_type: 'rfq_send',
      action_payload: {
        hand: 'email', method: 'POST', path: '/send',
        body: { to: 'sales@carr.example', subject: '[DD-RFQ-r1] Fabric request', text: 'Please quote.' },
      },
      evidence: { rfq_id: 'r1', intents: 'fi_1' },
    }));
    expect(r.routed).toBe('executed');
    expect(calls).toEqual(['https://graph.microsoft.com/v1.0/users/rob%40dearborndenim.com/sendMail']);
    expect(bot.sent.at(-1)!.text).toMatch(/Sent to sales@carr\.example: \[DD-RFQ-r1\]/);
    const rows = db.prepare('SELECT rfq_id, vendor_domain, intents, graph_message_id, vendor_slug, vendor_name FROM rfq_messages').all();
    // No evidence.vendor and no body.vendor_name on this proposal — vendor_slug stays null
    // and vendor_name falls back to the recipient's own domain, title-cased.
    expect(rows).toEqual([{
      rfq_id: 'r1', vendor_domain: 'carr.example', intents: 'fi_1', graph_message_id: 'g-7',
      vendor_slug: null, vendor_name: 'Carr',
    }]);
  });

  it('fails an email proposal when no Graph token is wired, without calling out', async () => {
    db.prepare("INSERT INTO trust_ledger (agent, brand_id, action_type, level) VALUES ('sourcing','dearborn-denim','rfq_send',2)").run();
    const r = await spine.file(input({
      agent: 'sourcing', action_type: 'rfq_send',
      action_payload: {
        hand: 'email', method: 'POST', path: '/send',
        body: { to: 'sales@carr.example', subject: 's', text: 't' },
      },
    }));
    expect(r.routed).toBe('execution_failed');
    expect(getProposalById(db, r.id)!.status).toBe('failed');
    expect(db.prepare('SELECT COUNT(*) AS n FROM rfq_messages').get()).toEqual({ n: 0 });
  });

  it('aborts a hung hand call after handTimeoutMs and records the failure', async () => {
    db.prepare("INSERT INTO trust_ledger (agent, brand_id, action_type, level) VALUES ('marketing-manager','dearborn-denim','creative_request',2)").run();
    const s = buildSpine({ db, transport: bot, now: () => NOW, env: { CONTENT_ENGINE_URL: 'https://ce.example', CONTENT_ENGINE_KEY: 'k' }, brandsDir: BRANDS, agentKeys: new Map(), fetch: hungFetch(), handTimeoutMs: 50 });
    const r = await s.file(input());
    expect(r.routed).toBe('execution_failed');
    const row = getProposalById(db, r.id)!;
    expect(row.status).toBe('failed');
    expect(JSON.parse(row.execution_result!).error).toMatch(/timeout|abort/i);
    expect(bot.sent.at(-1)!.text).toMatch(/failed/);
  });

  it('onText refuses a bare promote when several brands are configured', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-brands-'));
    try {
      const base = JSON.parse(fs.readFileSync(path.join(BRANDS, 'dearborn-denim.json'), 'utf8'));
      fs.writeFileSync(path.join(dir, 'dearborn-denim.json'), JSON.stringify(base));
      fs.writeFileSync(path.join(dir, 'other.json'), JSON.stringify({ ...base, brand_id: 'other' }));
      const s = buildSpine({ db, transport: bot, now: () => NOW, env: {}, brandsDir: dir, agentKeys: new Map(), fetch: async () => new Response('{}') });
      expect(await s.onText('555', 'promote marketing-manager creative_request 2', 'robert-mcmillan')).toBe(true);
      expect(bot.sent.at(-1)!.text).toMatch(/Several brands configured/);
      expect(db.prepare('SELECT COUNT(*) AS n FROM trust_ledger').get()).toEqual({ n: 0 });
      expect(await s.onText('555', 'promote marketing-manager creative_request 2 brand=other', 'robert-mcmillan')).toBe(true);
      expect(bot.sent.at(-1)!.text).toBe('marketing-manager creative_request → level 2 (other).');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('handleHttp files a proposal from a keyed POST and lands the card in the inbox chat', async () => {
    const KEY = 'k'.repeat(24);
    const s = buildSpine({ db, transport: bot, now: () => NOW, env: {}, brandsDir: BRANDS, agentKeys: new Map([[KEY, 'finance']]), fetch: async () => new Response('{}') });
    const { res, out } = fakeRes();
    const { agent: _agent, ...body } = input({ action_type: 'noop' });
    expect(await s.handleHttp(fakeReq('POST', '/spine/proposals', body, `Bearer ${KEY}`), res)).toBe(true);
    expect(out.status).toBe(200);
    const { id, routed } = JSON.parse(out.body);
    expect(routed).toBe('card');
    expect(bot.sent[0]!.chatId).toBe('555');
    expect(bot.sent[0]!.hasKeyboard).toBe(true);
    expect(bot.sent[0]!.text).toMatch(/finance/);
    expect(getProposalById(db, id)!.agent).toBe('finance');
  });
});
