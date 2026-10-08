import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import { initializeSchema } from '../../src/db/schema.js';
import { createUser, getUserById, setUserGrants, type User } from '../../src/db/user-queries.js';
import { getProposalById } from '../../src/db/proposal-queries.js';
import { ensureInitialTrust } from '../../src/db/trust-queries.js';
import { buildSpine } from '../../src/spine/wiring.js';
import { runExpirySweep } from '../../src/spine/jobs.js';
import { loadBrandConfig } from '../../src/spine/brand-config.js';
import type { InboxTransport } from '../../src/spine/telegram-card.js';
import { loadCatalogue, parseCatalogue, type StaffCatalogue } from '../../src/staff/catalogue.js';
import {
  buildWriteProposal, createWriteLimiter, executeStaffAction, validateParams, type StaffExecDeps,
} from '../../src/staff/execute.js';

const NOW = '2026-10-08T15:00:00.000Z';
const BRANDS = path.join(process.cwd(), 'config', 'brands');
const STORE = 'gid://shopify/Location/5526519911';
const FACTORY = 'gid://shopify/Location/30653830';
const cat: StaffCatalogue = loadCatalogue(path.join(process.cwd(), 'config', 'staff-actions.json'));
const brand = loadBrandConfig(BRANDS, 'dearborn-denim');

function kristina(over: Partial<User> = {}): User {
  return {
    id: 'kristina', name: 'Kristina', email: 'k@dd.com', role: 'member', telegram_chat_id: '777',
    timezone: 'America/Chicago', briefing_enabled: 1, briefing_cron: '', check_in_cron: null, eod_cron: null,
    briefing_sections_json: null, brand_id: 'dearborn-denim', grants_json: '["store"]', location_id: STORE,
    language: null, created_at: '', updated_at: '', ...over,
  };
}

/** A minimal valid catalogue to break one field at a time. */
function base(): Record<string, any> {
  return {
    groups: { store: ['look', 'set'] },
    actions: {
      look: {
        kind: 'read', description: 'Look.', hand: 'factory-fenix', method: 'GET',
        params: { q: { type: 'string', required: true, description: 'q' } },
        path: '/api/integration/inventory?q={q}',
      },
      set: {
        kind: 'write', description: 'Set.', hand: 'factory-fenix', method: 'POST',
        params: { sku: { type: 'string', required: true, description: 's' } },
        bind: { location_id: 'user.location_id' },
        path: '/api/integration/inventory/set', body: { sku: '{sku}', location_id: '{location_id}' },
        action_type: 'store_inventory_set', reversible: true, cost_usd: 0, level_required: 1, expires_hours: 24,
        summary: 'Set {sku}',
      },
    },
  };
}

describe('staff-action catalogue validator (spec §5)', () => {
  it('accepts the shipped catalogue with every v1 action', () => {
    expect(Object.keys(cat.actions).sort()).toEqual([
      'customer_order_lookup', 'inventory_lookup', 'inventory_transfer', 'material_request', 'ops_note',
      'pos_status', 'production_lookup', 'store_inventory_set', 'vendor_po_lookup', 'vendor_po_receive',
    ]);
    expect(cat.actions.customer_order_lookup!.description).toMatch(/^[^.]*customer order/i);
    expect(cat.actions.vendor_po_lookup!.description).toMatch(/^[^.]*vendor PO/);
    expect(cat.actions.vendor_po_receive!.description).toMatch(/^[^.]*vendor PO/);
  });

  it.each([
    ['an unknown action in a group', (c: any) => { c.groups.store.push('payroll'); }, /unknown action payroll/],
    ['a pinned action_type', (c: any) => { c.actions.set.action_type = 'price_change'; }, /pinned/],
    ['a read path outside /api/integration/', (c: any) => { c.actions.look.path = '/admin/inventory?q={q}'; }, /read path must start with \/api\/integration\//],
    ['an undeclared {param} in the body', (c: any) => { c.actions.set.body.extra = '{price}'; }, /\{price\} is not a declared/],
    ['an undeclared {param} in the summary', (c: any) => { c.actions.set.summary = 'Set {qty}'; }, /\{qty\} is not a declared/],
    ['a write with GET', (c: any) => { c.actions.set.method = 'GET'; }, /write may not use GET/],
    ['a binding that shadows a param', (c: any) => { c.actions.set.params.location_id = { type: 'string', description: 'x' }; }, /shadows a param/],
  ])('rejects %s', (_label, mutate, err) => {
    const c = base();
    mutate(c);
    expect(() => parseCatalogue(c)).toThrow(err);
  });
});

describe('staff-action params and payloads (spec §7.2)', () => {
  it('validates enums, ranges and lengths, and never files on a bad value', () => {
    const transfer = cat.actions.inventory_transfer!;
    const ok = { sku: 'H201-M', quantity: 4, direction: 'to_store', reason: 'weekend' };
    expect(validateParams(transfer, ok).ok).toBe(true);
    expect(validateParams(transfer, { ...ok, direction: 'to_warehouse' })).toEqual({ ok: false, error: 'direction must be one of to_store, to_factory' });
    expect(validateParams(transfer, { ...ok, quantity: 0 })).toEqual({ ok: false, error: 'quantity must be at least 1' });
    expect(validateParams(transfer, { ...ok, quantity: 10000 })).toEqual({ ok: false, error: 'quantity must be at most 9999' });
    expect(validateParams(transfer, { ...ok, quantity: 2.5 })).toEqual({ ok: false, error: 'quantity must be a whole number' });
    expect(validateParams(transfer, { ...ok, reason: 'x'.repeat(201) })).toEqual({ ok: false, error: 'reason must be at most 200 characters' });
    expect(validateParams(transfer, { sku: 'H201-M', quantity: 4, reason: 'r' })).toEqual({ ok: false, error: 'direction is required' });
    const receive = cat.actions.vendor_po_receive!;
    expect(validateParams(receive, { po_id: '12', lines: [{ quantity: 10 }] }))
      .toEqual({ ok: false, error: 'lines[0] needs one of line_id or sku' });
    expect(validateParams(receive, { po_id: '12', lines: Array.from({ length: 41 }, () => ({ sku: 'F1', quantity: 1 })) }).ok).toBe(false);
  });

  it('store_inventory_set binds the location from the user row and ignores a location in the input', () => {
    const action = cat.actions.store_inventory_set!;
    const v = validateParams(action, { sku: 'H201-M', quantity: 4, reason: 'recount', location_id: FACTORY, location: FACTORY });
    expect(v.ok).toBe(true);
    const r = buildWriteProposal(action, (v as { values: Record<string, unknown> }).values, kristina(), brand, 'set 4 H201 medium', NOW);
    expect(r.ok).toBe(true);
    const { input } = (r as { built: { input: any } }).built;
    expect(input.agent).toBe('kristina');
    expect(input.action_payload).toEqual({
      hand: 'factory-fenix', method: 'POST', path: '/api/integration/inventory/set',
      body: { sku: 'H201-M', location_id: STORE, quantity: 4, reason: 'recount', idempotency_key: '{{proposal.id}}' },
    });
    expect(input.evidence).toMatchObject({ requested_by: 'Kristina', request_text: 'set 4 H201 medium', sku: 'H201-M', quantity: 4 });
    expect(input.evidence).not.toHaveProperty('location_id');
    expect(input.expires_at).toBe('2026-10-09T15:00:00.000Z');
  });

  it('inventory_transfer takes the store from the user row and the Factory from the brand, by direction', () => {
    const action = cat.actions.inventory_transfer!;
    const build = (direction: string) => {
      const v = validateParams(action, { sku: 'H201-M', quantity: 3, direction, reason: 'r', from_location_id: 'gid://shopify/Location/1' });
      const r = buildWriteProposal(action, (v as any).values, kristina(), brand, 'moved 3', NOW);
      return (r as any).built.input.action_payload.body;
    };
    expect(build('to_store')).toEqual({ sku: 'H201-M', quantity: 3, idempotency_key: '{{proposal.id}}', from_location_id: FACTORY, to_location_id: STORE });
    expect(build('to_factory')).toEqual({ sku: 'H201-M', quantity: 3, idempotency_key: '{{proposal.id}}', from_location_id: STORE, to_location_id: FACTORY });
  });
});

describe('staff-action execution', () => {
  let db: Database.Database;
  let sent: { chatId: string; text: string; card: boolean }[];
  let transport: InboxTransport;
  let fetchMock: ReturnType<typeof vi.fn>;
  const env = { FACTORY_FENIX_URL: 'https://ff.example', FACTORY_FENIX_KEY: 'ffkey' };

  beforeEach(() => {
    db = new Database(':memory:'); initializeSchema(db);
    createUser(db, { id: 'robert-mcmillan', name: 'Robert', email: 'r@dd.com', role: 'admin', telegram_chat_id: '555' });
    createUser(db, { id: 'kristina', name: 'Kristina', email: 'k@dd.com', role: 'member', telegram_chat_id: '777', location_id: STORE });
    setUserGrants(db, 'kristina', ['store']);
    sent = [];
    transport = {
      async sendCard(chatId, text) { sent.push({ chatId, text, card: true }); return { message_id: sent.length }; },
      async sendText(chatId, text) { sent.push({ chatId, text, card: false }); },
    };
    fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
  });
  afterEach(() => db.close());

  function setup(clock: { now: string } = { now: NOW }) {
    const spine = buildSpine({ db, transport, now: () => clock.now, env, brandsDir: BRANDS, agentKeys: new Map(), fetch: fetchMock as never });
    const d: StaffExecDeps = {
      db, loadBrand: spine.loadBrand, env, handFetch: spine.handFetch, file: spine.file, now: () => clock.now, limiter: createWriteLimiter(),
    };
    const run = (id: string, input: unknown, text = 'msg') => executeStaffAction(d, cat, getUserById(db, 'kristina')!, id, input, text);
    return { spine, run };
  }
  /** An existing level-1 row: initial_level never touches it, so these filings take the card path. */
  const atLevel1 = (actionType: string) =>
    db.prepare("INSERT INTO trust_ledger (agent, brand_id, action_type, level) VALUES ('kristina','dearborn-denim',?,1)").run(actionType);

  it('a read can never be templated out of /api/integration/', async () => {
    const { run } = setup();
    // A value in the query stays a query value.
    await run('inventory_lookup', { q: '../../admin?x=1#y' });
    expect(fetchMock.mock.calls[0]![0]).toBe('https://ff.example/api/integration/inventory?q=..%2F..%2Fadmin%3Fx%3D1%23y');
    // A value in the path is one encoded segment; a slash or a dot-segment is refused before any call.
    const evil = parseCatalogue({
      groups: { store: ['peek'] },
      actions: { peek: { kind: 'read', description: 'p', hand: 'factory-fenix', method: 'GET', params: { id: { type: 'string', required: true, description: 'i' } }, path: '/api/integration/x/{id}' } },
    });
    const d: StaffExecDeps = { db, loadBrand: () => brand, env, handFetch: fetchMock as never, file: async () => ({ id: 0, routed: 'card' }), now: () => NOW, limiter: createWriteLimiter() };
    fetchMock.mockClear();
    for (const id of ['..', '../../admin', 'a/b']) {
      expect(await executeStaffAction(d, evil, kristina(), 'peek', { id }, 'm')).toMatch(/^Cannot look that up: id ".*" is not a valid id: slashes and dot-segments are not allowed in ids/);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ops_note goes end to end through spine.file on the built-in notes hand', async () => {
    const { run } = setup();
    atLevel1('ops_note');
    const reply = await run('ops_note', { text: 'machine 3 is down', urgency: 'now' }, 'machine 3 is down!!');
    expect(reply).toMatch(/^Filed #\d+ for Robert's approval/);
    const id = Number(/#(\d+)/.exec(reply)![1]);
    const row = getProposalById(db, id)!;
    expect(row.agent).toBe('kristina');
    expect(JSON.parse(row.action_payload)).toEqual({
      hand: 'notes', method: 'POST', path: '/note',
      body: { title: 'Note from Kristina (now)', summary: 'machine 3 is down' },
    });
    const card = sent.find((s) => s.card)!;
    expect(card.chatId).toBe('555');
    expect(card.text.split('\n')[1]).toBe('Requested by Kristina on Telegram: "machine 3 is down!!"');

    // Promoted to level 2: it posts and reports, no card, no HTTP call.
    db.prepare("UPDATE trust_ledger SET level = 2 WHERE agent = 'kristina' AND action_type = 'ops_note'").run();
    const done = await run('ops_note', { text: 'delivery came early' });
    expect(done).toBe('Done: Note from Kristina (fyi): delivery came early');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a double send runs once, a repeat 20 minutes later runs again, and staff executions emit no spine event', async () => {
    const clock = { now: NOW };
    const { run } = setup(clock);
    db.prepare("INSERT INTO trust_ledger (agent, brand_id, action_type, level) VALUES ('kristina','dearborn-denim','inventory_transfer',2)").run();
    const move = { sku: 'H201-M', quantity: 3, direction: 'to_store', reason: 'weekend' };
    expect(await run('inventory_transfer', move)).toMatch(/^Done:/);
    clock.now = '2026-10-08T15:00:40.000Z';
    expect(await run('inventory_transfer', move)).toBe(
      "That exact request ran at 10:00 (#1). If you mean another Move 3 × H201-M from the Factory to the store, add a different note (e.g. 'second batch') and ask again.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    clock.now = '2026-10-08T15:20:00.000Z';
    expect(await run('inventory_transfer', move)).toMatch(/^Done:/);
    const rows = db.prepare("SELECT id, status FROM proposals WHERE agent = 'kristina'").all() as { id: number; status: string }[];
    expect(rows.map((r) => r.status)).toEqual(['executed', 'executed']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body).idempotency_key).toBe(String(rows[1]!.id));
    expect(db.prepare('SELECT COUNT(*) AS n FROM spine_events').get()).toEqual({ n: 0 });

    // A still-pending identical request is the duplicate.
    atLevel1('ops_note');
    expect(await run('ops_note', { text: 'leak by door 2' })).toMatch(/^Filed #/);
    expect(await run('ops_note', { text: 'leak by door 2' })).toMatch(/^That's already filed as #\d+ and waiting for Robert/);
  });

  it('tells the requester how each proposal ended, and never the admin about their own', async () => {
    const { spine, run } = setup();
    atLevel1('store_inventory_set');
    const file = async (qty: number) => Number(/#(\d+)/.exec(await run('store_inventory_set', { sku: 'H201-M', quantity: qty, reason: 'recount' }))![1]);
    const toKristina = () => sent.filter((s) => s.chatId === '777').map((s) => s.text);

    const a = await file(1);
    await spine.onCallback(`prop:approve:${a}`, '555', 'robert-mcmillan');
    expect(toKristina().at(-1)).toBe(`#${a} Set H201-M to 1 at the store — approved and done.`);

    fetchMock.mockResolvedValueOnce(new Response('{"error":"bundle SKUs cannot be set","sku_class":"bundle"}', { status: 409 }));
    const f = await file(2);
    await spine.onCallback(`prop:approve:${f}`, '555', 'robert-mcmillan');
    expect(toKristina().at(-1)).toBe(`#${f} Set H201-M to 2 at the store — approved, but it failed: bundle SKUs cannot be set — SKU class: bundle. Robert has been told.`);

    const r = await file(3);
    await spine.onCallback(`prop:reject:${r}`, '555', 'robert-mcmillan');
    expect(toKristina().at(-1)).toBe(`#${r} Set H201-M to 3 at the store — rejected by Robert.`);

    const e = await file(4);
    await spine.onCallback(`prop:edit:${e}`, '555', 'robert-mcmillan');
    await spine.onText('555', 'quantity=5', 'robert-mcmillan');
    expect(toKristina().at(-1)).toBe(`#${e} Set H201-M to 4 at the store — approved with an edit by Robert and done.`);

    const x = await file(6);
    runExpirySweep(db, '2026-10-10T00:00:00.000Z', (rows) => { for (const p of rows) void spine.notifyRequester(p.id); });
    await new Promise((res) => setTimeout(res, 0));
    expect(toKristina().at(-1)).toBe(`#${x} Set H201-M to 6 at the store — expired without a decision; ask again if it is still needed.`);

    // Robert's own filing: decided, nothing extra to his chat beyond the card handler's reply.
    const own = await spine.file({
      agent: 'robert-mcmillan', brand_id: 'dearborn-denim', action_type: 'ops_note',
      action_payload: { hand: 'notes', method: 'POST', path: '/note', body: { title: 't', summary: 's' } },
      reason: 'mine', evidence: {}, cost_usd: 0, reversible: true, level_required: 1, expires_at: '2026-10-09T00:00:00.000Z',
    });
    const before = sent.length;
    await spine.onCallback(`prop:reject:${own.id}`, '555', 'robert-mcmillan');
    expect(sent.slice(before).map((s) => s.text)).toEqual([`Rejected #${own.id}.`]);
  });

  it('the first filing starts the ledger row at the catalogue initial_level; an existing row and a pinned type are never raised', async () => {
    const { run } = setup();
    const level = (t: string) => (db.prepare("SELECT level FROM trust_ledger WHERE agent = 'kristina' AND action_type = ?").get(t) as { level: number } | undefined)?.level;
    expect(level('ops_note')).toBeUndefined();
    // initial_level 2: the first request runs and reports, no card.
    expect(await run('ops_note', { text: 'first note' })).toBe('Done: Note from Kristina (fyi): first note');
    expect(level('ops_note')).toBe(2);
    expect(sent.some((s) => s.card)).toBe(false);
    // Robert set it back to 1: the next filing leaves it there and carded.
    db.prepare("UPDATE trust_ledger SET level = 1 WHERE agent = 'kristina' AND action_type = 'ops_note'").run();
    expect(await run('ops_note', { text: 'second note' })).toMatch(/^Filed #\d+ for Robert's approval/);
    expect(level('ops_note')).toBe(1);

    // A pinned type never starts above 1, whatever level is asked for.
    expect(ensureInitialTrust(db, { agent: 'kristina', brand_id: 'dearborn-denim', action_type: 'price_change' }, 3, NOW)).toBe(true);
    expect(level('price_change')).toBe(1);
    // And the validator refuses initial_level on a read or out of range.
    const c = base(); c.actions.set.initial_level = 4;
    expect(() => parseCatalogue(c)).toThrow(/initial_level must be 1, 2 or 3/);
    const r = base(); r.actions.look.initial_level = 2;
    expect(() => parseCatalogue(r)).toThrow(/initial_level is for writes only/);
    expect(cat.actions.vendor_po_receive!.initial_level).toBeUndefined();
  });
});
