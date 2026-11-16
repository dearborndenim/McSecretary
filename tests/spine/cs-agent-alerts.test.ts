import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import { initializeSchema } from '../../src/db/schema.js';
import { getTrustLevel, promoteTrust } from '../../src/db/trust-queries.js';
import { fileProposal, type RouterDeps } from '../../src/spine/router.js';
import { createSpineRouter } from '../../src/spine/api-routes.js';
import { parseAgentPolicy } from '../../src/spine/agent-policy.js';
import { checkCsAlertProposal, seedCsAlertTrust, CS_ALERTS_AGENT } from '../../src/spine/cs-agent-alerts.js';
import type { ProposalInput } from '../../src/spine/types.js';

const NOW = '2026-11-16T12:00:00.000Z';
const KEY = 'a'.repeat(32);
const TRUST_KEY = { agent: CS_ALERTS_AGENT, brand_id: 'dearborn-denim', action_type: 'cs_agent_alert' };

function alert(over: Record<string, unknown> = {}, mail: Record<string, unknown> = {}) {
  return {
    brand_id: 'dearborn-denim', action_type: 'cs_agent_alert',
    action_payload: { hand: 'email', method: 'POST', path: '/send',
      body: { to: ['rob@dearborndenim.com', 'kristina@dearborndenim.com'], subject: 'CS bot down', text: 'Gorgias key rejected', ...mail } },
    reason: 'outage', evidence: {}, cost_usd: 0, reversible: false, level_required: 2, expires_at: '2026-11-17T12:00:00.000Z',
    ...over,
  };
}

describe('checkCsAlertProposal', () => {
  it('passes an alert to company addresses and ignores every other agent and type', () => {
    expect(checkCsAlertProposal(CS_ALERTS_AGENT, alert())).toBeNull();
    expect(checkCsAlertProposal('marketing-manager', { action_type: 'creative_request' })).toBeNull();
  });

  it('refuses an outside, look-alike or display-name recipient, in to or cc', () => {
    expect(checkCsAlertProposal(CS_ALERTS_AGENT, alert({}, { to: ['someone@gmail.com'] }))).toMatch(/@dearborndenim.com/);
    expect(checkCsAlertProposal(CS_ALERTS_AGENT, alert({}, { cc: 'x@evil-dearborndenim.com' }))).toMatch(/@dearborndenim.com/);
    expect(checkCsAlertProposal(CS_ALERTS_AGENT, alert({}, { to: 'x@mail.dearborndenim.com' }))).toMatch(/@dearborndenim.com/);
    expect(checkCsAlertProposal(CS_ALERTS_AGENT, alert({}, { to: 'a@x.com@dearborndenim.com' }))).toMatch(/@dearborndenim.com/);
  });

  it('refuses attachments, another hand, another type from the key, and the type from another key', () => {
    expect(checkCsAlertProposal(CS_ALERTS_AGENT, alert({}, { attachments: [{ url: 'https://x/y', name: 'y' }] }))).toMatch(/attachments/);
    expect(checkCsAlertProposal(CS_ALERTS_AGENT, alert({ action_payload: { hand: 'notes', method: 'POST', path: '/note', body: {} } }))).toMatch(/email hand/);
    expect(checkCsAlertProposal(CS_ALERTS_AGENT, alert({ action_type: 'rfq_send' }))).toMatch(/only cs_agent_alert/);
    expect(checkCsAlertProposal('sourcing', alert())).toMatch(/only by cs-agent-alerts/);
  });
});

describe('cs_agent_alert trust and routing', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); initializeSchema(db); });
  afterEach(() => db.close());

  it('seeds level 2 only when the key exists, never over an existing row, and the alert auto-executes', async () => {
    expect(seedCsAlertTrust(db, ['cs-agent'], NOW)).toBe(false);
    expect(getTrustLevel(db, TRUST_KEY)).toBe(1);
    expect(seedCsAlertTrust(db, ['cs-agent', CS_ALERTS_AGENT], NOW)).toBe(true);
    expect(getTrustLevel(db, TRUST_KEY)).toBe(2);

    const executed: number[] = [];
    const deps: RouterDeps = {
      now: () => NOW, silentBudgetUsd: () => 0, report: async () => {},
      sendCard: async () => { throw new Error('no card expected'); },
      execute: async (id) => { executed.push(id); return { ok: true, http_status: 200, body: {} }; },
    };
    const r = await fileProposal(db, { ...(alert() as unknown as ProposalInput), agent: CS_ALERTS_AGENT }, deps);
    expect(r.routed).toBe('executed');
    expect(executed).toEqual([r.id]);

    promoteTrust(db, TRUST_KEY, 1, 'robert', NOW);
    expect(seedCsAlertTrust(db, [CS_ALERTS_AGENT], NOW)).toBe(false);
    expect(getTrustLevel(db, TRUST_KEY)).toBe(1);
  });

  it('POST /spine/proposals answers 403 and files nothing for an outside recipient', async () => {
    const filed: unknown[] = [];
    const handle = createSpineRouter({
      db, now: () => NOW, agentKeys: new Map([[KEY, CS_ALERTS_AGENT]]),
      brandsDir: path.join(process.cwd(), 'config', 'brands'),
      file: async (input) => { filed.push(input); return { id: 1, routed: 'executed' }; },
      handFetch: async () => new Response('{}'), env: {},
    });
    const call = async (body: unknown) => {
      const out = { status: 0, body: '' };
      const chunks = [Buffer.from(JSON.stringify(body))];
      const listeners: Record<string, ((...a: unknown[]) => void)[]> = {};
      const req = { method: 'POST', url: '/spine/proposals', headers: { authorization: `Bearer ${KEY}` }, destroyed: false,
        on(ev: string, fn: (...a: unknown[]) => void) { (listeners[ev] ??= []).push(fn); return req; },
        destroy() { return req; }, pause() { return req; } };
      queueMicrotask(() => { for (const c of chunks) listeners.data?.forEach((f) => f(c)); listeners.end?.forEach((f) => f()); });
      const res = { writeHead(s: number) { out.status = s; return res; }, end(b?: string, cb?: () => void) { out.body = b ?? ''; cb?.(); } };
      await handle(req as never, res as never);
      return out;
    };
    expect((await call(alert({}, { to: 'customer@gmail.com' }))).status).toBe(403);
    expect(filed).toHaveLength(0);
    expect((await call(alert())).status).toBe(200);
    expect(filed).toHaveLength(1);
  });

  it('a cs-agent-alerts key with no AGENT_POLICY entry stops the boot', () => {
    expect(() => parseAgentPolicy('{}', [CS_ALERTS_AGENT])).toThrow(/must have an AGENT_POLICY entry/);
  });
});
