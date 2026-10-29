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
import fs from 'node:fs';
import os from 'node:os';
import { loadCatalogue, parseCatalogue, type StaffCatalogue } from '../../src/staff/catalogue.js';
import { renderCsThread, renderRead, RENDER_CAP } from '../../src/staff/render.js';
import { staffActionIdsForUser } from '../../src/staff/tools.js';
import {
  buildWriteProposal, createWriteLimiter, executeStaffAction, refusalDetail, validateParams, type StaffExecDeps,
} from '../../src/staff/execute.js';
import { checkPerSku, checkPoReceipt, type OpenPo } from '../../src/staff/limits.js';
import { createGrokActionHandler, handIdempotencyKey, withLevelsByLocation, type ActionResult, type GrokActionDeps } from '../../src/staff/grok-action.js';
import { getAuditById } from '../../src/db/operator-queries.js';
import { registerOriginBot } from '../../src/staff/admin-commands.js';
import { setCatalogue } from '../../src/staff/catalogue.js';
import { parseAgentPolicy } from '../../src/spine/agent-policy.js';

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

const arrayParam = { type: 'array', required: true, max: 5, description: 'p', items: { po_number: { type: 'integer', required: true, description: 'n' } } };

describe('staff-action catalogue validator (spec §5)', () => {
  it('accepts the shipped catalogue with every v1 action', () => {
    expect(Object.keys(cat.actions).sort()).toEqual([
      'ap_aging', 'ap_bill_hold', 'ap_bill_release', 'ap_bills_due', 'ap_exceptions', 'ap_match_accept',
      'ap_pay_run_approve', 'ap_pay_run_waiting', 'ap_vendor_status',
      'cs_assign_me', 'cs_close', 'cs_my_queue', 'cs_note', 'cs_reply', 'cs_search', 'cs_ticket',
      'customer_order_lookup', 'inventory_lookup', 'inventory_transfer', 'material_request', 'ops_note',
      'pickup_approve', 'pickup_collected', 'pickup_hold', 'pickup_mark_ready', 'pickup_release', 'pickup_reschedule', 'pickup_status',
      'pos_status', 'production_lookup', 'store_inventory_set', 'vendor_po_approve', 'vendor_po_lookup', 'vendor_po_receive',
      'vendor_po_waiting',
    ]);
    // Inbound pickups (kanban Build P1): Robert alone approves a quote (cost bound to it), holds and releases; the driver group marks collected.
    for (const admin of ['pickup_approve', 'pickup_hold', 'pickup_release']) expect(Object.values(cat.groups).flat()).not.toContain(admin);
    expect(cat.groups.driver).toEqual(['pickup_status', 'pickup_collected', 'ops_note']);
    const pa = cat.actions.pickup_approve!;
    expect([pa.reversible, pa.cost_usd, pa.initial_level]).toEqual([false, { param: 'quote_usd', unit_usd: 1 }, 1]);
    expect(cat.groups.office).toContain('vendor_po_waiting');
    // Payables (quickbooks-sync F1) are reads only, for the office group and admins.
    for (const id of ['ap_aging', 'ap_bills_due', 'ap_vendor_status', 'ap_exceptions', 'ap_pay_run_waiting']) {
      expect([cat.actions[id]!.kind, cat.actions[id]!.hand, cat.groups.office.includes(id)]).toEqual(['read', 'quickbooks-sync', true]);
    }
    // Payables writes (F2): only Robert approves a pay run or accepts a payment match (admin only, a card at level 1;
    // the agent's own ap_pay_run / ap_payment_match proposals are the pinned gates, which staff may never file);
    // the office group may hold and release bills at level 2.
    for (const admin of ['ap_pay_run_approve', 'ap_match_accept']) expect(Object.values(cat.groups).flat()).not.toContain(admin);
    const apLevels = Object.fromEntries(['ap_pay_run_approve', 'ap_match_accept', 'ap_bill_hold', 'ap_bill_release'].map((id) => {
      const a = cat.actions[id]!;
      return [id, [a.kind, a.hand, a.action_type, a.reversible, a.level_required, a.initial_level ?? 1, cat.groups.office.includes(id)]];
    }));
    expect(apLevels).toEqual({
      ap_pay_run_approve: ['write', 'quickbooks-sync', 'ap_pay_run_approve', false, 1, 1, false],
      ap_match_accept: ['write', 'quickbooks-sync', 'ap_match_accept', false, 1, 1, false],
      ap_bill_hold: ['write', 'quickbooks-sync', 'ap_bill_hold', true, 1, 2, true],
      ap_bill_release: ['write', 'quickbooks-sync', 'ap_bill_release', true, 1, 2, true],
    });
    // Only Robert approves money: the approve action is in no group, so only an admin has it.
    expect(Object.values(cat.groups).flat()).not.toContain('vendor_po_approve');
    // Approving sends the PO: irreversible, starts at level 2 (runs and reports), and the filing goes stale in an hour.
    const approve = cat.actions.vendor_po_approve!;
    expect([approve.hand, approve.action_type, approve.reversible, approve.cost_usd, approve.level_required, approve.initial_level, approve.expires_hours])
      .toEqual(['kanban-purchaser', 'vendor_po_approve', false, 0, 1, 2, 1]);
    expect(cat.groups.cs).toEqual(['cs_my_queue', 'cs_search', 'cs_ticket', 'cs_reply', 'cs_note', 'cs_close', 'cs_assign_me', 'ops_note']);
    // An email cannot be unsent: cs_reply is irreversible and starts at level 1 (a card) until Robert promotes it.
    const levels = Object.fromEntries(['cs_reply', 'cs_note', 'cs_close', 'cs_assign_me'].map((id) => {
      const a = cat.actions[id]!;
      return [id, [a.action_type, a.reversible, a.cost_usd, a.level_required, a.initial_level ?? 1]];
    }));
    expect(levels).toEqual({
      cs_reply: ['cs_staff_reply', false, 0, 1, 1],
      cs_note: ['cs_staff_note', true, 0, 1, 2],
      cs_close: ['cs_staff_close', true, 0, 1, 2],
      cs_assign_me: ['cs_staff_assign', true, 0, 1, 2],
    });
    expect(Object.keys(brand.hands)).toContain('cs-desk');
    expect(Object.keys(loadBrandConfig(BRANDS, 'knits').hands)).toContain('cs-desk');
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
    ['an array count outside the summary', (c: any) => { c.actions.set.params.pos = arrayParam; c.actions.set.body.n = '{#pos}'; }, /\{#pos\} is not a declared/],
    ['an array field the items do not declare', (c: any) => { c.actions.set.params.pos = arrayParam; c.actions.set.summary = 'Set {pos.vendor}'; }, /\{pos\.vendor\} is not a declared/],
    ['an array count of a scalar param', (c: any) => { c.actions.set.summary = 'Set {#sku}'; }, /\{#sku\} is not a declared/],
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

  it('cs_reply binds the author from the user row and the idempotency key to the proposal id, so a retry cannot send twice', () => {
    const action = cat.actions.cs_reply!;
    const v = validateParams(action, { ticket_id: '1042', text: 'Hi Jane, the 32x30 ships today.', author: 'robert', idempotency_key: 'k1' });
    const r = buildWriteProposal(action, (v as any).values, kristina({ grants_json: '["cs"]' }), brand, 'reply to 1042', NOW);
    expect((r as any).built.input.action_payload).toEqual({
      hand: 'cs-desk', method: 'POST', path: '/api/integration/tickets/1042/reply',
      body: { text: 'Hi Jane, the 32x30 ships today.', close: false, author: 'kristina', idempotency_key: '{{proposal.id}}', brand: 'dearborn-denim' },
    });
  });

  it('cs_note posts the note text to the note route with the bound author, brand and proposal-id key', () => {
    const action = cat.actions.cs_note!;
    const v = validateParams(action, { ticket_id: '1042', note: 'Called her; she wants 32x30.', author: 'robert' });
    const r = buildWriteProposal(action, (v as any).values, kristina({ grants_json: '["cs"]' }), brand, 'note on 1042', NOW) as any;
    expect(r.built.input.action_payload).toEqual({
      hand: 'cs-desk', method: 'POST', path: '/api/integration/tickets/1042/note',
      body: { text: 'Called her; she wants 32x30.', author: 'kristina', idempotency_key: '{{proposal.id}}', brand: 'dearborn-denim' },
    });
    expect(r.built.summary).toBe('Add a note to ticket #1042');
    expect(validateParams(action, { ticket_id: '1042', note: 'x'.repeat(4001) })).toEqual({ ok: false, error: 'note must be at most 4000 characters' });
  });

  it("every cs action carries the user's own brand to cs-desk, never one from input, so a ticket of another brand answers not_found", async () => {
    const knits = loadBrandConfig(BRANDS, 'knits');
    const user = kristina({ grants_json: '["cs"]', brand_id: 'knits' });
    const csIds = cat.groups.cs!.filter((id) => id.startsWith('cs_'));
    const spoof = { ticket_id: '1042', text: 'Hi', note: 'n', by: 'email', value: 'a@b.co', brand: 'dearborn-denim', brand_id: 'dearborn-denim' };
    for (const id of csIds.filter((i) => cat.actions[i]!.kind === 'write')) {
      const action = cat.actions[id]!;
      const v = validateParams(action, spoof);
      const r = buildWriteProposal(action, (v as any).values, user, knits, 'r', NOW) as any;
      expect([id, r.built.input.action_payload.body.brand, r.built.input.brand_id]).toEqual([id, 'knits', 'knits']);
    }
    const urls: string[] = [];
    const handFetch = vi.fn(async (url: string) => { urls.push(url); return new Response('{"error":"not_found"}', { status: 404 }); });
    const d: StaffExecDeps = {
      db: new Database(':memory:'), loadBrand: () => knits, env: { CS_DESK_URL: 'https://cs.example', CS_DESK_KEY: 'k' },
      handFetch: handFetch as never, file: async () => ({ id: 0, routed: 'card' }), now: () => NOW, limiter: createWriteLimiter(),
    };
    const reads = csIds.filter((i) => cat.actions[i]!.kind === 'read');
    for (const id of reads) await executeStaffAction(d, cat, user, id, spoof, 'r');
    expect(urls).toHaveLength(reads.length);
    for (const u of urls) expect(new URL(u).searchParams.getAll('brand')).toEqual(['knits']);
  });
});

describe('vendor_po_approve (purchasing Build 6b)', () => {
  const robert = (): User => kristina({ id: 'robert-mcmillan', name: 'Robert', role: 'admin', grants_json: '[]', location_id: null });
  const two = { pos: [{ po_number: 1003, total_usd: 342, version: 'a1b2c3d4' }, { po_number: '1005', total_usd: '368.40', version: ' 9f8e7d6c ', vendor: 'YKK' }], approved_by: 'Kristina' };

  it('passes the confirmed POs through as a list of objects, binds the approver and key, and names the POs in the summary', () => {
    const action = cat.actions.vendor_po_approve!;
    const v = validateParams(action, two);
    const r = buildWriteProposal(action, (v as any).values, robert(), brand, 'approve all POs', NOW) as any;
    expect(r.built.input.action_payload).toEqual({
      hand: 'kanban-purchaser', method: 'POST', path: '/api/integration/pos/approve',
      body: {
        pos: [{ po_number: 1003, total_usd: 342, version: 'a1b2c3d4' }, { po_number: 1005, total_usd: 368.4, version: '9f8e7d6c' }],
        approved_by: 'Robert', idempotency_key: '{{proposal.id}}',
      },
    });
    expect(r.built.summary).toBe('Approve 2 vendor PO(s): 1003, 1005');
    expect(r.built.input.expires_at).toBe('2026-10-08T16:00:00.000Z');
    const withReason = buildWriteProposal(action, { ...(v as any).values, reason: 'in chat' }, robert(), brand, 'r', NOW) as any;
    expect(withReason.built.input.action_payload.body.reason).toBe('in chat');
    expect(validateParams(action, { pos: [{ po_number: 1003, version: 'a1b2c3d4' }] })).toEqual({ ok: false, error: 'pos[0].total_usd is required' });
    expect(validateParams(action, { pos: [{ po_number: 1003, total_usd: 342 }] })).toEqual({ ok: false, error: 'pos[0].version is required' });
    expect(validateParams(action, { pos: [{ po_number: 999, total_usd: 1, version: 'v' }] })).toEqual({ ok: false, error: 'pos[0].po_number must be at least 1001' });
  });

  it('is listed for an admin and refused for a member, even one in every group', async () => {
    const everyGroup = kristina({ grants_json: JSON.stringify(Object.keys(cat.groups)) });
    expect(staffActionIdsForUser(cat, robert())).toContain('vendor_po_approve');
    expect(staffActionIdsForUser(cat, everyGroup)).not.toContain('vendor_po_approve');
    const file = vi.fn();
    const d: StaffExecDeps = { db: new Database(':memory:'), loadBrand: () => brand, env: {}, handFetch: vi.fn() as never, file, now: () => NOW, limiter: createWriteLimiter() };
    expect(await executeStaffAction(d, cat, everyGroup, 'vendor_po_approve', two, 'approve all POs'))
      .toBe('The action vendor_po_approve is not available to you. Nothing was done; ask Robert if you need it.');
    expect(file).not.toHaveBeenCalled();
  });

  it("files as the user, runs at level 2 and hands kanban's notify back to the chat and Robert's report", async () => {
    const db = new Database(':memory:'); initializeSchema(db);
    createUser(db, { id: 'robert-mcmillan', name: 'Robert', email: 'r@dd.com', role: 'admin', telegram_chat_id: '555' });
    const sent: string[] = [];
    const transport: InboxTransport = { async sendCard() { return { message_id: 1 }; }, async sendText(_c, text) { sent.push(text); } };
    const notify = 'Approved 1 PO: PO 1003 Cone Denim $342.00 (sent by email). Not approved: PO 1005, total changed.';
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ results: [], notify }), { status: 200 }));
    const env = { KANBAN_PURCHASER_URL: 'https://kp.example', KANBAN_PURCHASER_KEY: 'kpkey' };
    const spine = buildSpine({ db, transport, now: () => NOW, env, brandsDir: BRANDS, agentKeys: new Map(), fetch: fetchMock as never });
    const d: StaffExecDeps = { db, loadBrand: spine.loadBrand, env, handFetch: spine.handFetch, file: spine.file, now: () => NOW, limiter: createWriteLimiter() };
    const reply = await executeStaffAction(d, cat, getUserById(db, 'robert-mcmillan')!, 'vendor_po_approve', two, 'approve all POs');
    expect(reply).toBe(`Done: ${notify}`);
    expect(sent).toEqual([`Executed #1 robert-mcmillan vendor_po_approve (level 2, 200). ${notify}`]);
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('https://kp.example/api/integration/pos/approve');
    expect(JSON.parse(init.body as string)).toEqual({
      pos: [{ po_number: 1003, total_usd: 342, version: 'a1b2c3d4' }, { po_number: 1005, total_usd: 368.4, version: '9f8e7d6c' }], approved_by: 'Robert', idempotency_key: '1',
    });

    // The look-up: vendor goes in the query when given and is left out when not.
    fetchMock.mockClear();
    await executeStaffAction(d, cat, getUserById(db, 'robert-mcmillan')!, 'vendor_po_waiting', { vendor: 'Cone Denim' }, 'cone POs');
    await executeStaffAction(d, cat, getUserById(db, 'robert-mcmillan')!, 'vendor_po_waiting', {}, 'all POs');
    expect(fetchMock.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      'https://kp.example/api/integration/pos?status=waiting&vendor=Cone+Denim',
      'https://kp.example/api/integration/pos?status=waiting',
    ]);
    db.close();
  });
});

describe("cs-desk's 409s read for a person", () => {
  it('names the surviving ticket, the missing address, and a same-key request still in flight (which may have sent)', () => {
    expect(refusalDetail({ error: 'merged', into: 1050 })).toBe('ticket was merged into #1050; use ticket 1050 instead');
    expect(refusalDetail({ error: 'no_customer' })).toBe('the ticket has no customer email address, so no reply can be sent from here');
    expect(refusalDetail({ error: 'request with this idempotency_key is in progress' })).toBe(
      'the same request is still running on the customer-service desk and may already have gone out; check the ticket before asking again',
    );
  });
});

describe('cs-desk look-ups rendered for Telegram', () => {
  const fixture = (name: string) => fs.readFileSync(path.join(process.cwd(), 'tests', 'fixtures', 'cs-desk', name), 'utf8');

  it('renders a thread as plain text with notes marked and quoted history dropped', () => {
    const text = renderRead('cs_thread', fixture('thread.json'))!;
    expect(text.length).toBeLessThanOrEqual(RENDER_CAP);
    expect(text).toContain('Ticket #1042 · waiting_human · assigned kristina · priority high · tags needs-human, exchange');
    expect(text).toContain('Customer: Jane Doe <jane.doe@example.com>');
    expect(text).toContain('[INTERNAL NOTE by BOT, not sent to the customer · Oct 10 14:31]\n[AI Handoff] exchange');
    expect(text).toContain('[CUSTOMER wrote · Oct 10 09:02]\nHi,\n\nI ordered the Straight Fit in 32x30');
    expect(text).toContain('(1 attachment: tag.jpg)');
    expect(text).toContain("[SENT TO CUSTOMER by BOT · Oct 10 09:05]\nHi Jane, sorry about that! I've passed this to our team so they can set up the exchange.\n\n[");
    expect(text).not.toMatch(/wrote:|^>|\r|<\/?[a-z]+>|\*\*/m);
  });

  it('keeps a long thread under the Telegram cap and always shows the newest message', () => {
    const t = JSON.parse(fixture('thread.json'));
    t.messages = Array.from({ length: 40 }, (_, i) => ({ ...t.messages[0], id: i, body_text: `message ${i} ${'x'.repeat(2000)}`, created_at: new Date(Date.parse('2026-10-01T00:00:00Z') + i * 60_000).toISOString() }));
    const text = renderCsThread(t)!;
    expect(text.length).toBeLessThanOrEqual(RENDER_CAP);
    expect(text).toContain('message 39 ');
    expect(text).not.toContain('message 31 ');
    expect(text).toMatch(/^Last \d of 40 messages, oldest first \(\d+ earlier not shown\):$/m);
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

  it('cs_my_queue binds the brand and the caller as assignee, never from input, and renders the list', async () => {
    db.prepare("UPDATE users SET grants_json = '[\"cs\"]' WHERE id = 'kristina'").run();
    const csEnv = { ...env, CS_DESK_URL: 'https://cs.example', CS_DESK_KEY: 'cskey' };
    const list = fs.readFileSync(path.join(process.cwd(), 'tests', 'fixtures', 'cs-desk', 'tickets.json'), 'utf8');
    const handFetch = vi.fn(async () => new Response(list, { status: 200 }));
    const d: StaffExecDeps = { db, loadBrand: () => brand, env: csEnv, handFetch: handFetch as never, file: async () => ({ id: 0, routed: 'card' }), now: () => NOW, limiter: createWriteLimiter() };
    const out = await executeStaffAction(d, cat, getUserById(db, 'kristina')!, 'cs_my_queue', { assignee: 'robert', brand_id: 'knits' }, 'my queue');
    expect(handFetch.mock.calls[0]![0]).toBe('https://cs.example/api/integration/tickets?brand=dearborn-denim&status=waiting_human&assignee=kristina&limit=20');
    expect(out).toBe([
      '2 tickets, most recently updated first:',
      '#1042 · waiting_human · high · Jane Doe <jane.doe@example.com> · "Wrong inseam on my order #D48211" · customer wrote Oct 10 14:30',
      '#1038 · waiting_human · sam@example.org · "Hem service" · we wrote Oct 9 12:45',
    ].join('\n'));
  });

  it('cs_search sends exactly one of email, order or q with the bound brand and renders the compact list', async () => {
    db.prepare("UPDATE users SET grants_json = '[\"cs\"]' WHERE id = 'kristina'").run();
    const csEnv = { ...env, CS_DESK_URL: 'https://cs.example', CS_DESK_KEY: 'cskey' };
    const list = fs.readFileSync(path.join(process.cwd(), 'tests', 'fixtures', 'cs-desk', 'tickets.json'), 'utf8');
    const handFetch = vi.fn(async () => new Response(list, { status: 200 }));
    const d: StaffExecDeps = { db, loadBrand: () => brand, env: csEnv, handFetch: handFetch as never, file: async () => ({ id: 0, routed: 'card' }), now: () => NOW, limiter: createWriteLimiter() };
    const run = (input: unknown) => executeStaffAction(d, cat, getUserById(db, 'kristina')!, 'cs_search', input, 'find');
    const out = await run({ by: 'order', value: '#309610' });
    await run({ by: 'email', value: 'Jane.Doe@example.com' });
    await run({ by: 'text', value: 'wrong inseam' });
    expect(handFetch.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      'https://cs.example/api/integration/tickets?brand=dearborn-denim&order=%23309610&limit=20',
      'https://cs.example/api/integration/tickets?brand=dearborn-denim&email=Jane.Doe%40example.com&limit=20',
      'https://cs.example/api/integration/tickets?brand=dearborn-denim&q=wrong+inseam&limit=20',
    ]);
    expect(out.split('\n')[1]).toBe('#1042 · waiting_human · high · Jane Doe <jane.doe@example.com> · "Wrong inseam on my order #D48211" · customer wrote Oct 10 14:30');
    expect(await run({ by: 'phone', value: '555' })).toMatch(/^Not filed: by must be one of email, order, text/);
    expect(handFetch).toHaveBeenCalledTimes(3);
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

describe('OPERATOR direct-action limits (spec 2026-10-27, Robert\'s numbers)', () => {
  it('ships one hard limit, 25 per SKU on a transfer, and the PO receipt read; recounts are unlimited', () => {
    expect(cat.actions.store_inventory_set!.limits).toBeUndefined();
    expect(cat.actions.inventory_transfer!.limits).toEqual({ per_sku: { max_units: 25 } });
    expect(cat.actions.vendor_po_receive!.limits).toEqual({ po_receipt: { read_path: '/api/integration/pos?status=ordered' } });
    const operator = Object.values(cat.actions).filter((a) => a.operator).map((a) => a.id).sort();
    expect(operator).toEqual(['customer_order_lookup', 'inventory_lookup', 'inventory_transfer', 'pickup_status', 'pos_status',
      'production_lookup', 'store_inventory_set', 'vendor_po_lookup', 'vendor_po_receive', 'vendor_po_waiting']);
  });

  it('validates the operator block and the brand locations registry at boot', () => {
    const r = base();
    r.actions.set.switch = undefined;
    r.actions.set.operator = { omit: ['sku'], params: { where: { type: 'string', description: 'w' } }, locations: ['where'] };
    expect(() => parseCatalogue(r)).toThrow(/\{sku\} is not a declared param/);
    r.actions.set.operator = { params: { sku: { type: 'string', description: 'x' } } };
    expect(() => parseCatalogue(r)).toThrow(/shadows a param/);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loc-'));
    const raw = JSON.parse(fs.readFileSync(path.join(BRANDS, 'dearborn-denim.json'), 'utf8'));
    raw.locations.factory.aliases = ['store'];
    fs.writeFileSync(path.join(dir, 'dearborn-denim.json'), JSON.stringify(raw));
    expect(() => loadBrandConfig(dir, 'dearborn-denim')).toThrow(/locations: store names two locations/);
  });

  it('transfer 25 runs, 26 is refused', () => {
    const l = cat.actions.inventory_transfer!.limits!.per_sku!;
    expect(checkPerSku(25, 'H201-M', l).ok).toBe(true);
    const r = checkPerSku(26, 'H201-M', l);
    expect(!r.ok && r.reason).toBe('26 × H201-M is more than the 25 units per SKU allowed per request. Nothing was moved.');
  });

  const po: OpenPo = { id: 7, po_number: 1003, lines: [
    { line_id: 41, sku: 'ZIP-5', name: 'zippers', unit: 'units', quantity: 95, received_quantity: 0 },
    { line_id: 42, sku: 'THR-1', name: 'thread cones', unit: 'cones', quantity: 10, received_quantity: 4 },
  ] };

  it('PO line of 95: 37 runs flagged short, 95 runs clean, 96 runs flagged over', () => {
    expect(checkPoReceipt(po, [{ line_id: 41, quantity: 37 }]))
      .toMatchObject({ ok: true, flags: ['We only got 37 of the 95 zippers ordered on PO 1003.'] });
    expect(checkPoReceipt(po, [{ sku: 'zip-5', quantity: 95 }])).toMatchObject({ ok: true, flags: [] });
    expect(checkPoReceipt(po, [{ line_id: 41, quantity: 96 }]))
      .toMatchObject({ ok: true, flags: ['We got 96 of the 95 zippers ordered on PO 1003.'] });
  });

  it('measures a partly received line by what is still open, sums a line named twice, refuses another unit', () => {
    expect(checkPoReceipt(po, [{ line_id: 42, quantity: 6 }])).toMatchObject({ ok: true, flags: [] });
    expect(checkPoReceipt(po, [{ line_id: 42, quantity: 4 }, { sku: 'THR-1', quantity: 3 }]))
      .toMatchObject({ ok: true, flags: ['We got 7 of the 6 thread cones still open (10 ordered) on PO 1003.'] });
    expect(checkPoReceipt(po, [{ line_id: 42, quantity: 2 }]))
      .toMatchObject({ flags: ['We only got 2 of the 6 thread cones still open (10 ordered) on PO 1003.'] });
    const unit = checkPoReceipt(po, [{ line_id: 41, quantity: 5, unit: 'boxes' }]);
    expect(!unit.ok && unit.reason).toMatch(/counts zippers in units, not boxes/);
  });
});

describe('OPERATOR grok_action → action_result (spec 2026-10-27)', () => {
  let db: Database.Database;
  let calls: { url: string; method: string; body: unknown }[];
  let woke: [string, number][];
  let answers: Record<string, () => Response>;
  const env = {
    FACTORY_FENIX_URL: 'https://ff.example', FACTORY_FENIX_KEY: 'ffkey',
    KANBAN_PURCHASER_URL: 'https://kp.example', KANBAN_PURCHASER_KEY: 'kpkey',
  };
  const lookup = (store: number) => JSON.stringify({ variants: [{ sku: 'MICA-32-30', levels: { factory: 40, store } }] });
  const pos = JSON.stringify({ pos: [{ id: 7, po_number: 1003, lines: [
    { line_id: 41, sku: 'ZIP-5', name: 'zippers', unit: 'units', quantity: 95, received_quantity: 0 },
  ] }] });

  beforeEach(() => {
    setCatalogue(cat);
    db = new Database(':memory:'); initializeSchema(db);
    createUser(db, { id: 'kristina', name: 'Kristina', email: 'k@dd.com', role: 'member', location_id: STORE });
    setUserGrants(db, 'kristina', ['store', 'receiving']);
    createUser(db, { id: 'olivier', name: 'Olivier', email: 'o@dd.com', role: 'member', location_id: STORE });
    setUserGrants(db, 'olivier', ['store']);
    registerOriginBot(db, 'kristina-assistant', 'k@dd.com', 'reads,store_inventory_set,vendor_po_receive', NOW);
    registerOriginBot(db, 'olivier-stock', 'o@dd.com', 'inventory_lookup', NOW);
    calls = []; woke = [];
    answers = {
      'GET ff /api/integration/inventory': () => new Response(lookup(25), { status: 200 }),
      'POST ff /api/integration/inventory/set': () => new Response('{"ok":true,"notify":"MICA-32-30 set to 24"}', { status: 200 }),
      'POST ff /api/integration/inventory/transfer': () => new Response('{"ok":true}', { status: 200 }),
      'GET kp /api/integration/pos': () => new Response(pos, { status: 200 }),
      'POST kp /api/integration/pos/7/receive': () => new Response('{"po_number":1003,"notify":"PO 1003: received 37 zippers"}', { status: 200 }),
    };
  });
  afterEach(() => { db.close(); setCatalogue(null); });

  // Frank's live entry plus grok_action; grok-olive is an assistant key that has not opted in.
  const frankPolicy = (types: string[]) => ({ propose: null, events: { post_types: types, drain_types: ['grok_task_frank'], source_hand: 'self' }, rate: { events_per_hour: 300 } });
  const agentPolicy = parseAgentPolicy(JSON.stringify({
    'grok-frank': frankPolicy(['grok_result', 'grok_report', 'grok_profile', 'grok_daily', 'grok_action']),
    'grok-olive': frankPolicy(['grok_result', 'grok_report', 'grok_*']),
    'grok-newbie': frankPolicy(['grok_action']),
  }), ['grok-frank', 'grok-olive', 'grok-newbie']);

  function handler() {
    const handFetch = async (url: string, init: RequestInit) => {
      const u = new URL(url);
      const method = init.method ?? 'GET';
      calls.push({ url, method, body: init.body ? JSON.parse(String(init.body)) : undefined });
      const key = `${method} ${u.host.split('.')[0]} ${u.pathname}`;
      return answers[key]?.() ?? new Response('{"error":"no route"}', { status: 404 });
    };
    const d: GrokActionDeps = {
      db, now: () => NOW, env, loadBrand: () => brand, handFetch, catalogue: () => cat,
      wake: (t, id) => { woke.push([t, id]); }, agentPolicy,
    };
    return createGrokActionHandler(d);
  }

  function post(payload: Record<string, unknown>, opts: { agent?: string; source?: string } = {}) {
    return handler()(opts.agent ?? 'grok-bots', {
      source_hand: opts.source ?? 'grok-operator', brand_id: 'dearborn-denim', event_type: 'grok_action', urgent: false,
      payload: { bot: 'operator', sent_at: NOW, idempotency_key: 'act-1',
        request_id: typeof payload.idempotency_key === 'string' ? `OP-${payload.idempotency_key}` : 'OP-1',
        origin: { person: 'k@dd.com', bot: 'kristina-assistant' }, action: 'inventory_lookup', params: { q: 'MICA-32-30' },
        operator_check: { rule: 'reads', verdict: 'ok' }, ...payload },
    });
  }

  const events = (type: string) => (db.prepare('SELECT * FROM spine_events WHERE event_type = ? ORDER BY id').all(type) as { payload: string; posted_by: string | null; source_hand: string }[])
    .map((e) => ({ ...e, payload: JSON.parse(e.payload) as Record<string, any> }));

  it('answers a read on grok_task_chief in the task shape OPERATOR drains, and wakes it', async () => {
    const a = post({});
    expect(a.status).toBe(200);
    const r = (await a.done)!;
    expect(r).toEqual({
      request_id: 'OP-1', origin: { person: 'k@dd.com', bot: 'kristina-assistant' }, action: 'inventory_lookup',
      status: 'ok', result: withLevelsByLocation(JSON.parse(lookup(25)), brand), audit_id: r.audit_id, reason: null,
    });
    const [task] = events('grok_task_chief');
    expect(task!.payload).toEqual({ task_id: `action-result-${r.audit_id}`, kind: 'action_result', args: r, notify: false, due: null, filed_by: 'mcsecretary', reply_type: null });
    expect(woke).toEqual([['grok_task_chief', (db.prepare("SELECT id FROM spine_events WHERE event_type='grok_task_chief'").get() as { id: number }).id]]);
    // The grok_action itself is stored, already drained by McSecretary, never left for a drainer.
    expect(db.prepare("SELECT drained_by FROM spine_events WHERE event_type='grok_action'").get()).toEqual({ drained_by: 'mcsecretary' });
    expect(events('grok_report')).toEqual([]);
  });

  it('runs a recount within limits with no approval, mapping the hand payload, and audits it', async () => {
    const r = (await post({ action: 'store_inventory_set', params: { sku: 'MICA-32-30', quantity: 24, reason: 'recount' } }).done)!;
    expect(r.status).toBe('ok');
    const write = calls.find((c) => c.method === 'POST')!;
    expect(write.body).toEqual({ sku: 'MICA-32-30', location_id: STORE, quantity: 24, reason: 'recount', idempotency_key: handIdempotencyKey('grok-bots', 'OP-1') });
    expect(db.prepare('SELECT COUNT(*) AS n FROM proposals').get()).toEqual({ n: 0 });
    const row = getAuditById(db, r.audit_id)!;
    expect([row.person, row.user_id, row.origin_bot, row.via, row.request_id, row.status, row.hand_status])
      .toEqual(['k@dd.com', 'kristina', 'kristina-assistant', 'grok-operator', 'OP-1', 'ok', 200]);
  });

  it('maps a named location: recount at the factory, transfer by from/to keys or aliases, with allow_over on receipts', async () => {
    const set = (await post({ idempotency_key: 'l1', action: 'store_inventory_set', params: { sku: 'MICA-32-30', quantity: 4, reason: 'r', location: 'Factory' } }).done)!;
    expect(set.status).toBe('ok');
    registerOriginBot(db, 'kristina-assistant', 'k@dd.com', 'reads,store_inventory_set,inventory_transfer,vendor_po_receive', NOW);
    const t = (await post({ idempotency_key: 'l2', action: 'inventory_transfer', params: { sku: 'MICA-32-30', quantity: 25, from: 'factory', to: 'store', reason: 'restock' } }).done)!;
    expect(t.status).toBe('ok');
    const over = (await post({ idempotency_key: 'l3', action: 'inventory_transfer', params: { sku: 'MICA-32-30', quantity: 26, from: 'factory', to: 'andersonville', reason: 'restock' } }).done)!;
    expect([over.status, over.reason]).toEqual(['refused', '26 × MICA-32-30 is more than the 25 units per SKU allowed per request. Nothing was moved.']);
    const same = (await post({ idempotency_key: 'l4', action: 'inventory_transfer', params: { sku: 'X', quantity: 1, from: 'store', to: 'andersonville', reason: 'r' } }).done)!;
    expect(same.reason).toBe('From and to are both andersonville; nothing would move.');
    await post({ idempotency_key: 'l5', action: 'vendor_po_receive', params: { po_id: '7', lines: [{ line_id: 41, quantity: 96 }] } }).done;
    const posts = calls.filter((c) => c.method === 'POST').map((c) => c.body as Record<string, unknown>);
    expect(posts[0]).toMatchObject({ location_id: FACTORY, quantity: 4 });
    expect(posts[1]).toEqual({ sku: 'MICA-32-30', quantity: 25, from_location_id: FACTORY, to_location_id: STORE, reason: 'restock', idempotency_key: handIdempotencyKey('grok-bots', 'OP-l2') });
    expect(posts[2]).toMatchObject({ allow_over: true, lines: [{ line_id: 41, quantity: 96 }] });
    expect(posts).toHaveLength(3);
  });

  it('asks which location when the request names none and the person has none; refuses an unknown name', async () => {
    db.prepare("UPDATE users SET location_id = NULL WHERE id = 'kristina'").run();
    const none = (await post({ idempotency_key: 'w1', action: 'store_inventory_set', params: { sku: 'X', quantity: 1, reason: 'r' } }).done)!;
    expect(none.reason).toBe('Which location? Kristina has no registered location of their own; name one of: factory, andersonville (store).');
    const bad = (await post({ idempotency_key: 'w2', action: 'store_inventory_set', params: { sku: 'X', quantity: 1, reason: 'r', location: 'Wicker Park' } }).done)!;
    expect(bad.reason).toMatch(/^Unknown location "Wicker Park"/);
    expect(calls).toEqual([]);
  });

  it('gives inventory_lookup levels for every registered location and asks factory-fenix for all of them', async () => {
    const r = (await post({}).done)!;
    expect((r.result as any).variants[0].levels_by_location).toEqual({ factory: 40, andersonville: 25 });
    expect((r.result as any).locations).toEqual({ factory: 'the Factory', andersonville: 'Andersonville' });
    expect(new URL(calls[0]!.url).searchParams.get('locations')).toBe(`${FACTORY},${STORE}`);
    // Once factory-fenix answers per gid, a third registered store needs no code change.
    const three = { ...brand, locations: { ...brand.locations, wicker: { location_id: 'gid://shopify/Location/9', name: 'Wicker Park' } } };
    const body = { variants: [{ sku: 'A', levels: { factory: 1, store: 2 }, levels_by_location: { 'gid://shopify/Location/9': 7 } }] };
    expect((withLevelsByLocation(body, three) as any).variants[0].levels_by_location).toEqual({ factory: 1, andersonville: 2, wicker: 7 });
  });

  it('runs any recount change: 4 → 6, 100 → 104, 100 → 106', async () => {
    for (const [i, q] of [6, 104, 106].entries()) {
      const r = (await post({ idempotency_key: `rc-${i}`, action: 'store_inventory_set', params: { sku: 'MICA-32-30', quantity: q, reason: 'recount' } }).done)!;
      expect(r.status).toBe('ok');
    }
    expect(calls.filter((c) => c.method === 'POST').map((c) => (c.body as { quantity: number }).quantity)).toEqual([6, 104, 106]);
  });

  it('receives a short PO line and carries the flag for Robert; line_id reaches kanban as an integer', async () => {
    // Regression (review #3): a string line_id passed validation and kanban answered 400.
    const r = (await post({ action: 'vendor_po_receive', params: { po_id: '7', lines: [{ line_id: '41', quantity: 37 }] } }).done)!;
    expect(r.status).toBe('ok');
    expect(r.flag_for_robert).toEqual(['We only got 37 of the 95 zippers ordered on PO 1003.']);
    expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({ lines: [{ line_id: 41, quantity: 37 }], received_by: 'Kristina', idempotency_key: handIdempotencyKey('grok-bots', 'OP-1') });
  });

  it('origin checks: none, unknown bot, someone else\'s bot, an action the bot or the groups lack', async () => {
    const run = async (p: Record<string, unknown>, key: string) => (await post({ ...p, idempotency_key: key }).done)!;
    const none = await run({ origin: undefined }, 'k1');
    expect([none.status, none.reason]).toEqual(['refused', expect.stringMatching(/no origin/)]);
    expect(events('grok_report')).toHaveLength(1); // a malformed request goes to the desk
    expect((await run({ origin: { person: 'k@dd.com', bot: 'ghost' } }, 'k2')).reason).toMatch(/ghost is not registered/);
    expect((await run({ origin: { person: 'k@dd.com', bot: 'olivier-stock' } }, 'k3')).reason).toMatch(/not registered to Kristina/);
    expect((await run({ origin: { person: 'nobody@dd.com', bot: 'olivier-stock' } }, 'k4')).reason).toMatch(/No staff user/);
    const botLacks = await run({ origin: { person: 'o@dd.com', bot: 'olivier-stock' }, action: 'store_inventory_set', params: { sku: 'X', quantity: 1, reason: 'r' } }, 'k5');
    expect(botLacks.reason).toBe('The bot olivier-stock may not use store_inventory_set.');
    registerOriginBot(db, 'olivier-stock', 'o@dd.com', 'inventory_lookup,vendor_po_receive', NOW);
    const groupLacks = await run({ origin: { person: 'o@dd.com', bot: 'olivier-stock' }, action: 'vendor_po_receive', params: { po_id: '7', lines: [{ line_id: 41, quantity: 1 }] } }, 'k6');
    expect(groupLacks.reason).toBe("vendor_po_receive is not allowed for Olivier's groups.");
    expect(calls).toEqual([]);
  });

  it('files unknown actions, invalid params and hand failures to the Chief desk as OPERATOR needs_claude reports', async () => {
    await post({ action: 'make_basket', idempotency_key: 'u1' }).done;
    await post({ action: 'store_inventory_set', params: { sku: 'X' }, idempotency_key: 'u2' }).done;
    answers['GET ff /api/integration/inventory'] = () => new Response('boom', { status: 500 });
    const failed = (await post({ idempotency_key: 'u3' }).done)!;
    expect(failed.status).toBe('failed');
    const reports = events('grok_report');
    expect(reports.map((e) => [e.source_hand, e.posted_by, e.payload.bot, e.payload.filed_by])).toEqual(Array(3).fill(['grok-operator', null, 'operator', 'mcsecretary']));
    expect(reports.map((e) => e.payload.title)).toEqual([
      'needs_claude: OPERATOR OP-u1 make_basket refused', 'needs_claude: OPERATOR OP-u2 store_inventory_set refused', 'needs_claude: OPERATOR OP-u3 inventory_lookup failed',
    ]);
    expect(reports[2]!.payload.needs_claude[0]).toMatch(/answered 500/);
  });

  it('runs the same idempotency_key once', async () => {
    const first = post({ action: 'store_inventory_set', params: { sku: 'MICA-32-30', quantity: 24, reason: 'recount' } });
    const second = post({ action: 'store_inventory_set', params: { sku: 'MICA-32-30', quantity: 24, reason: 'recount' } });
    expect(second.body).toEqual({ id: first.body.id, audit_id: first.body.audit_id, duplicate: true, status: 'running' });
    await first.done; await second.done;
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    expect(events('grok_task_chief')).toHaveLength(1);
  });

  it('reports a kanban outage on the PO pre-read as failed, a 4xx as refused, and writes nothing (review #6)', async () => {
    const receive = (key: string) => post({ idempotency_key: key, action: 'vendor_po_receive', params: { po_id: '7', lines: [{ line_id: 41, quantity: 37 }] } }).done;
    answers['GET kp /api/integration/pos'] = () => new Response('upstream down', { status: 503 });
    expect((await receive('p1'))!.status).toBe('failed');
    answers['GET kp /api/integration/pos'] = () => { throw new TypeError('fetch failed'); };
    expect((await receive('p2'))!.status).toBe('failed');
    answers['GET kp /api/integration/pos'] = () => new Response('{"error":"status must be waiting, ordered or received"}', { status: 400 });
    expect((await receive('p3'))!.status).toBe('refused');
    answers['GET kp /api/integration/pos'] = () => new Response('{"pos":[]}', { status: 200 });
    expect((await receive('p4'))!.reason).toMatch(/not open for receiving/);
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  it('runs a resend of the same request_id under a new idempotency_key once (review #4)', async () => {
    const params = { sku: 'MICA-32-30', quantity: 24, reason: 'recount' };
    const first = post({ action: 'store_inventory_set', params });
    await first.done;
    const resend = handler()('grok-bots', {
      source_hand: 'grok-operator', brand_id: 'dearborn-denim', event_type: 'grok_action', urgent: false,
      payload: { bot: 'operator', sent_at: NOW, idempotency_key: 'act-1-retry', request_id: 'OP-1',
        origin: { person: 'k@dd.com', bot: 'kristina-assistant' }, action: 'store_inventory_set', params },
    });
    expect(resend.body).toEqual({ id: first.body.id, audit_id: first.body.audit_id, duplicate: true, status: 'ok' });
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    // The hand key comes from the request, so a resend that did reach a hand would replay, not write.
    expect(handIdempotencyKey('grok-bots', 'OP 1/x')).toMatch(/^grok-op-OP_1_x-[0-9a-f]{12}$/);
    expect(handIdempotencyKey('grok-bots', 'OP 1/x')).not.toBe(handIdempotencyKey('grok-bots', 'OP_1_x'));
  });

  describe('vendor_po_lookup with PO details (kanban GET /pos?status=ordered)', () => {
    const fixture = fs.readFileSync(path.join(process.cwd(), 'tests', 'fixtures', 'kanban', 'pos-ordered.json'), 'utf8');
    beforeEach(() => { answers['GET kp /api/integration/pos'] = () => new Response(fixture, { status: 200 }); });
    const lookup = async (params: Record<string, unknown>, key = 'pl') => (await post({ idempotency_key: key, action: 'vendor_po_lookup', params }).done)!;

    it('maps each PO and line: ordered, received, open = ordered − received floored at 0, other fields passed through', async () => {
      const r = await lookup({ po: '1003' });
      expect(r.status).toBe('ok');
      const u = new URL(calls[0]!.url);
      expect([u.pathname, u.searchParams.get('status'), u.searchParams.has('vendor')]).toEqual(['/api/integration/pos', 'ordered', false]);
      const res = r.result as any;
      expect([res.as_of, res.count, res.match]).toEqual(['2026-10-27T14:05:11.402Z', 1, { po: '1003' }]);
      expect(res.pos[0]).toEqual({
        po_id: 7, po_number: 1003, vendor: 'YKK USA', vendor_code: 'YKK', status: 'PARTIALLY_RECEIVED', total_usd: '412.50',
        ordered_at: '2026-10-14T16:22:03.118Z', expected_delivery: '2026-10-30', vendor_confirmation: 'SO-88214', carrier: 'UPS',
        tracking_number: '1Z999AA10123456784', shipped_at: '2026-10-22T19:00:00.000Z', last_received_at: '2026-10-24T15:10:44.900Z',
        lines: [
          { line_id: 41, sku: 'ZIP-5', name: 'zippers', unit: 'units', ordered: 95, received: 0, open: 95, unit_cost: 1.5, line_total: 142.5 },
          { line_id: 42, sku: 'THR-1', name: 'thread cones', unit: 'cones', ordered: 10, received: 4, open: 6, unit_cost: 27, line_total: 270 },
          { line_id: 43, sku: 'RIV-AB', name: 'antique brass rivets', unit: 'boxes', ordered: 2, received: 3, open: 0, unit_cost: 0, line_total: 0 },
        ],
      });
      expect(res.message).toBeUndefined();
    });

    it('answers an unfiltered lookup as a compact list without lines', async () => {
      const res = (await lookup({})).result as any;
      expect(res.pos).toEqual([
        { po_id: 7, po_number: 1003, vendor: 'YKK USA', status: 'PARTIALLY_RECEIVED', expected_delivery: '2026-10-30', open_lines: 2, open_units: 101 },
        { po_id: 5, po_number: 1001, vendor: 'Cone Denim', status: 'ORDERED', expected_delivery: null, open_lines: 1, open_units: 1500 },
      ]);
      expect(res.message).toBe('2 open POs; name one with po for its lines.');
    });

    it('keeps 200 POs as valid JSON under the result cap: unfiltered summaries, and a filtered answer sheds the oldest lines first', async () => {
      const big = JSON.parse(fixture);
      const line = big.pos[0].lines[0];
      big.pos = Array.from({ length: 200 }, (_, i) => ({ ...big.pos[0], id: 1000 + i, po_number: 5000 - i, vendor: i % 4 ? 'YKK USA' : 'Cone Denim',
        lines: Array.from({ length: 6 }, (_, j) => ({ ...line, line_id: i * 10 + j })) }));
      answers['GET kp /api/integration/pos'] = () => new Response(JSON.stringify(big), { status: 200 });
      const all = await lookup({}, 'c1');
      expect(all.status).toBe('ok');
      expect((all.result as any).truncated).toBeUndefined();
      expect(JSON.stringify(all.result).length).toBeLessThan(32_000);
      expect((all.result as any).pos).toHaveLength(200);
      expect((all.result as any).pos[0]).not.toHaveProperty('lines');
      // 50 Cone POs with 6 lines each are ~80 KB in full: the newest keep their lines, the oldest become summaries.
      const cone = (await lookup({ q: 'Cone Denim' }, 'c2')).result as any;
      expect(JSON.stringify(cone).length).toBeLessThan(32_000);
      expect(cone.pos).toHaveLength(50);
      expect(cone.pos[0].lines).toHaveLength(6);
      expect(cone.pos.at(-1)).toEqual(expect.objectContaining({ po_number: 5000 - 196, open_lines: 6, open_units: 570 }));
      expect(cone.pos.at(-1)).not.toHaveProperty('lines');
      expect(cone.partial).toMatch(/name one with po for its lines\.$/);
    });

    it('filters by po (number, "PO 1003", or kanban id) and by q (vendor, line name or SKU)', async () => {
      const nums = async (params: Record<string, unknown>, key: string) => ((await lookup(params, key)).result as any).pos.map((p: any) => p.po_number);
      expect(await nums({ po: '1003' }, 'f1')).toEqual([1003]);
      expect(await nums({ po: 'PO #1001' }, 'f2')).toEqual([1001]);
      expect(await nums({ po: '7' }, 'f3')).toEqual([1003]);
      expect(await nums({ q: 'Cone Denim' }, 'f4')).toEqual([1001]);
      expect(await nums({ q: 'cone' }, 'f8')).toEqual([1003, 1001]); // "thread cones" matches too
      expect(await nums({ q: 'brass rivet' }, 'f5')).toEqual([1003]);
      expect(await nums({ q: 'thr-1' }, 'f6')).toEqual([1003]);
      const none = (await lookup({ po: '1003', q: 'denim' }, 'f7')).result as any;
      expect([none.count, none.message]).toEqual([0, 'PO 1003 is open, but nothing on it matches "denim".']);
    });

    it('answers a PO that is not open plainly, as ok and not a failure', async () => {
      const r = await lookup({ po: 'PO 1004' });
      expect([r.status, r.reason]).toEqual(['ok', null]);
      expect(r.result).toEqual({ as_of: '2026-10-27T14:05:11.402Z', match: { po: 'PO 1004' }, count: 0, pos: [], message: "PO 1004 isn't open for receiving." });
      expect(events('grok_report')).toEqual([]);
    });

    it('reads again by vendor when kanban\'s list is cut at 200, and says the list is partial for a PO it cannot reach', async () => {
      const full = { as_of: 'x', pos: Array.from({ length: 200 }, (_, i) => ({ id: 1000 + i, po_number: 5000 - i, vendor: 'Other', lines: [] })) };
      const old = { as_of: 'x', pos: [{ id: 3, po_number: 1000, vendor: 'Cone Denim', vendor_code: 'CONE', lines: [] }] };
      // The handFetch stub records the call before answering, so the last call is this request.
      answers['GET kp /api/integration/pos'] = () => new Response(JSON.stringify(new URL(calls.at(-1)!.url).searchParams.get('vendor') === 'cone' ? old : full), { status: 200 });
      const q = await lookup({ q: 'cone' }, 't1');
      expect(calls.map((c) => new URL(c.url).searchParams.get('vendor'))).toEqual([null, 'cone']);
      expect((q.result as any).pos.map((p: any) => p.po_number)).toEqual([1000]);
      const po = (await lookup({ po: '999' }, 't2')).result as any;
      expect([po.message, po.partial]).toEqual(["PO 999 isn't open for receiving.", 'kanban lists only the newest 200 open POs, so an older open PO would not show here.']);
    });
  });

  it('takes grok_action only from the grok-bots key as grok-operator', () => {
    expect(post({}, { agent: 'marketing-manager' }).status).toBe(403);
    expect(post({}, { source: 'grok-gina' }).status).toBe(403);
    expect(post({}, { source: 'grok-bots' }).status).toBe(403);
    expect(post({ request_id: '' }).status).toBe(400);
  });

  describe('a staff assistant on its own key (grok-frank)', () => {
    beforeEach(() => { registerOriginBot(db, 'frank', 'k@dd.com', 'reads,store_inventory_set', NOW); });
    const frank = (payload: Record<string, unknown>, agent = 'grok-frank') => post({
      bot: agent.slice(5), request_id: 'FR-1', origin: { person: 'k@dd.com', bot: agent.slice(5) }, ...payload,
    }, { agent, source: agent });

    it('runs an action for its registered person and answers on grok_task_frank, audited via grok-frank', async () => {
      const a = frank({ action: 'store_inventory_set', params: { sku: 'MICA-32-30', quantity: 24, reason: 'recount' } });
      expect(a.status).toBe(200);
      const r = (await a.done)!;
      expect(r.status).toBe('ok');
      expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({ location_id: STORE, quantity: 24, idempotency_key: handIdempotencyKey('grok-frank', 'FR-1') });
      const [task] = events('grok_task_frank');
      expect(task!.payload.args).toEqual(r);
      expect(woke).toEqual([['grok_task_frank', expect.any(Number)]]);
      expect(events('grok_task_chief')).toEqual([]);
      const row = getAuditById(db, r.audit_id)!;
      expect([row.posted_by, row.via, row.origin_bot, row.user_id]).toEqual(['grok-frank', 'grok-frank', 'frank', 'kristina']);
    });

    it('is refused (403, nothing stored) unless its policy lists grok_action exactly, or it posts as another source', () => {
      expect(frank({}, 'grok-olive').status).toBe(403);
      expect(post({ bot: 'operator', origin: { person: 'k@dd.com', bot: 'frank' } }, { agent: 'grok-frank', source: 'grok-operator' }).status).toBe(403);
      expect(events('grok_action')).toEqual([]);
    });

    it('binds identity to the key: another bot, another person, or an unregistered bot is refused and nothing runs', async () => {
      const otherBot = (await frank({ origin: { person: 'k@dd.com', bot: 'kristina-assistant' }, request_id: 'FR-2', idempotency_key: 'f2' }).done)!;
      expect(otherBot.reason).toBe("This request came in on grok-frank's key, so origin.bot must be frank, not kristina-assistant.");
      const otherPerson = (await frank({ origin: { person: 'o@dd.com', bot: 'frank' }, request_id: 'FR-3', idempotency_key: 'f3' }).done)!;
      expect(otherPerson.reason).toBe('The bot frank is not registered to Olivier; a bot acts only for its own person.');
      const unregistered = (await frank({ request_id: 'NB-1', idempotency_key: 'n1' }, 'grok-newbie').done)!;
      expect(unregistered.reason).toMatch(/^The bot newbie is not registered/);
      expect([otherBot.status, otherPerson.status, unregistered.status]).toEqual(['refused', 'refused', 'refused']);
      expect(calls).toEqual([]);
      expect(events('grok_task_frank')).toHaveLength(2);
      expect(events('grok_task_newbie')).toHaveLength(1);
    });

    it('turns a free-text request into a Chief-desk work order that answers on grok_task_frank', async () => {
      const r = (await frank({ action: 'work_order', params: { request: 'Merab needs the Mica fall reorder costed' } }).done)!;
      expect(r.status).toBe('refused');
      const [report] = events('grok_report');
      expect([report!.source_hand, report!.posted_by, report!.payload.bot, report!.payload.filed_by, report!.payload.title])
        .toEqual(['grok-frank', null, 'frank', 'mcsecretary', 'needs_claude: frank FR-1 work_order refused']);
      expect(report!.payload.needs_claude[0]).toMatch(/^frank request FR-1 .* via frank: .*Mica fall reorder costed/);
      expect(events('grok_task_frank')).toHaveLength(1);
      expect(events('grok_task_chief')).toEqual([]);
    });

    it('carries an 8,000-char request to the desk intact; the 2,000-char summary says it was cut', async () => {
      const request = `${'x'.repeat(7990)} END`;
      await frank({ action: 'work_order', params: { request } }).done;
      const [report] = events('grok_report');
      expect(report!.payload.needs_claude[0]).toContain(`${request}"}`);
      expect(report!.payload.summary).toHaveLength(2000);
      expect(report!.payload.summary).toMatch(/…\[truncated, \d+ chars\]$/);
    });
  });
});
