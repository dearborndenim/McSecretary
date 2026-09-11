/**
 * Chat → agent-graph router tools (spec §1.1).
 *
 * Four tools the chat loop's model can call. They only ever READ the graph or
 * FILE a proposal into the existing spine — no second approval flow, no second
 * scheduler, and no write to product-dev, design-module or Shopify from chat.
 * A dispatch becomes a pinned level-1 card; nothing runs until Robert taps
 * Approve and the built-in `graph` hand emits the events.
 *
 * Dependencies are injected once at boot (the `setRfqIntakeHandler` pattern),
 * so this module imports nothing from `src/index.ts` and every tool degrades to
 * one explanatory sentence when the graph is not wired.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type Database from 'better-sqlite3';
import { loadBrandConfig, resolveHand } from '../spine/brand-config.js';
import { resolveHandUrl } from '../spine/executor.js';
import { RUN_REQUEST_PREFIX, GRAPH_DISPATCH_PATH } from '../spine/graph-hand.js';
import {
  validateDispatchPlan, renderPlanReason, type ApprovedPersonaCounts, type DispatchPlan,
} from '../spine/graph-plan.js';
import { listProposalsByAgent, getProposalById } from '../db/proposal-queries.js';
import { getUserById } from '../db/user-queries.js';
import { latestRunStartedAt } from '../db/run-index-queries.js';
import { insertEvent, countPendingByType } from '../db/event-queries.js';
import type { ActionPayload, ProposalInput } from '../spine/types.js';
import type { Routed } from '../spine/router.js';

export interface GraphDeps {
  db: Database.Database;
  brandId: string;
  brandsDir: string;
  /** key -> agent, from parseAgentKeys. The values are the known agent names. */
  agentKeys: Map<string, string>;
  env: Record<string, string | undefined>;
  now: () => string;
  file: (input: ProposalInput) => Promise<{ id: number; routed: Routed }>;
  handFetch: (url: string, init: RequestInit) => Promise<Response>;
}

export const GRAPH_DEPS_MISSING_MESSAGE =
  'The agent graph is not configured on this instance, so I cannot reach it.';
/** Only an admin may read the graph or dispatch work into it. */
export const GRAPH_NOT_ADMIN_MESSAGE =
  'The business agent graph is admin-only, so I cannot read it or dispatch work into it for you — Robert can.';

const READ_AGENT_OUTPUTS_DEFAULT = 5;
const READ_AGENT_OUTPUTS_MAX = 20;
const HAND_READ_PATH_PREFIX = '/api/integration/';
const HAND_READ_CAP_BYTES = 8192;
const STALE_MS = 24 * 60 * 60 * 1000;
/** design-module's persona index — deliberately NOT reachable through read_hand. */
const PERSONAS_PATH = '/api/config/personas';
const PERSONAS_HAND = 'design-module';

let deps: GraphDeps | null = null;

export function setGraphDeps(d: GraphDeps | null): void {
  deps = d;
}

export const GRAPH_TOOL_DEFINITIONS: Anthropic.Tool[] = [
  {
    name: 'propose_graph_dispatch',
    description:
      'Draft a dispatch plan for the business agent graph and file it as a Telegram card for Robert to approve. Use it when a message gives a clear instruction to the design, sourcing or agent side of the business — one plan covering everything in that message. If the message is thinking out loud, or its scope is ambiguous, ask one clarifying question instead of calling this. It only files a card: no agent starts, no event is emitted, and no fabric is bought until Robert taps Approve. Returns the card number.',
    input_schema: {
      type: 'object' as const,
      properties: {
        plan: {
          type: 'object',
          description:
            'The dispatch plan. {summary: one line; briefs: [{collection_name, line: "mens"|"womens"|"both", brief_text (>=40 chars, Robert\'s words plus the inferred constraints), season?, target_launch? (YYYY-MM-DD), product_count? (1-8), price_ladder? (value|core|premium), fabric_locks?, vendor?, dye_program? ("pfd_house_dye"|"vendor_dyed"), persona? (default "all")}]; vendor_contacts: [{vendor_name, slug?, contact_name?, email?, phone?, sells?, notes?}]; run_requests: [{agent, reason}]}. At least one of the three lists must be non-empty. One brief per concept — never one brief listing several fabrics. Never set fabric_catalog.',
        },
      },
      required: ['plan'],
    },
  },
  {
    name: 'read_agent_outputs',
    description:
      'The newest proposals an agent has filed for this brand (any status), plus when that agent last ran and whether that run is stale (older than 24 hours). Read this FIRST for any question about cash, capacity, ads, sourcing, collections or production.',
    input_schema: {
      type: 'object' as const,
      properties: {
        agent: { type: 'string', description: 'Agent name, e.g. "finance", "production-planner", "marketing-manager", "sourcing".' },
        limit: { type: 'integer', description: `How many proposals to return (default ${READ_AGENT_OUTPUTS_DEFAULT}, max ${READ_AGENT_OUTPUTS_MAX}).` },
      },
      required: ['agent'],
    },
  },
  {
    name: 'read_hand',
    description:
      'Read live data straight from a service the agents use. Read-only GET; the path must start with /api/integration/. Use it to put a current number next to an agent\'s last filed report.',
    input_schema: {
      type: 'object' as const,
      properties: {
        hand: { type: 'string', description: 'Service name from the brand config, e.g. "quickbooks-sync", "ad-manager", "product-dev".' },
        path: { type: 'string', description: 'Path starting with /api/integration/, e.g. "/api/integration/finance-week".' },
      },
      required: ['hand', 'path'],
    },
  },
  {
    name: 'request_agent_run',
    description:
      'Ask the Mac mini to run an agent now instead of waiting for its schedule. Use only when read_agent_outputs came back stale. The agent\'s usual cards reach Telegram on their own.',
    input_schema: {
      type: 'object' as const,
      properties: {
        agent: { type: 'string', description: 'Agent name to run.' },
        reason: { type: 'string', description: 'Why the run is needed, in one line — it lands on the run request event.' },
      },
      required: ['agent', 'reason'],
    },
  },
];

export function isGraphTool(name: string): boolean {
  return GRAPH_TOOL_DEFINITIONS.some((t) => t.name === name);
}

/** The calling user, when the chat loop named one and the row still exists. */
function callingUser(d: GraphDeps, userId: string | undefined): { name: string; isAdmin: boolean } | null {
  if (!userId) return null;
  const u = getUserById(d.db, userId);
  if (!u) return null;
  return { name: u.name, isAdmin: u.role === 'admin' };
}

/** The agents that can be read or woken. `mcsecretary` is the caller, not a callee. */
function knownAgents(d: GraphDeps): string[] {
  return [...new Set(d.agentKeys.values())].sort();
}

function unknownAgentMessage(d: GraphDeps, name: string): string {
  return `Unknown agent: ${name}. Known agents: ${knownAgents(d).join(', ')}.`;
}

/**
 * Approved personas per line, for the designer-run estimate on the card. A
 * fixed, hardcoded path on a fixed hand — deliberately not reachable through
 * `read_hand`, whose /api/integration/ prefix rule stands unchanged. Any
 * failure returns null, which downgrades the estimate line rather than
 * blocking the card.
 */
async function readApprovedPersonaCounts(d: GraphDeps): Promise<ApprovedPersonaCounts | null> {
  try {
    const brand = loadBrandConfig(d.brandsDir, d.brandId);
    const target = resolveHand(brand, PERSONAS_HAND, d.env);
    const resolved = resolveHandUrl(target.url, PERSONAS_PATH);
    if (!resolved.ok) return null;
    const res = await d.handFetch(resolved.href, {
      method: 'GET',
      headers: { Authorization: `Bearer ${target.bearer}`, Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const body = JSON.parse(await res.text()) as { personas?: unknown };
    if (!Array.isArray(body.personas)) return null;
    const counts: ApprovedPersonaCounts = { mens: 0, womens: 0 };
    for (const p of body.personas) {
      if (typeof p !== 'object' || p === null) continue;
      const row = p as { line?: unknown; status?: unknown };
      if (row.status !== 'approved') continue;
      if (row.line === 'mens' || row.line === 'womens') counts[row.line] += 1;
    }
    return counts;
  } catch {
    return null;
  }
}

async function proposeGraphDispatch(
  d: GraphDeps, input: Record<string, unknown>, requestedBy: string,
): Promise<string> {
  const nowIso = d.now();
  const validated = validateDispatchPlan(input.plan, nowIso);
  if (!validated.ok) return `That plan is not valid: ${validated.error}`;
  const plan: DispatchPlan = validated.plan;

  const known = new Set(knownAgents(d));
  for (const r of plan.run_requests) {
    if (!known.has(r.agent)) return unknownAgentMessage(d, r.agent);
  }

  const personas = await readApprovedPersonaCounts(d);
  const reason = renderPlanReason(plan, personas);
  const design_runs_estimated = personas
    ? plan.briefs.reduce((sum, b) => sum + personas[b.line], 0)
    : null;

  const brand = loadBrandConfig(d.brandsDir, d.brandId);
  const expires_at = new Date(Date.parse(nowIso) + brand.proposal_expiry_hours * 3_600_000).toISOString();

  const action_payload: ActionPayload = {
    hand: 'graph', method: 'POST', path: GRAPH_DISPATCH_PATH,
    body: plan as unknown as Record<string, unknown>,
  };
  const { id, routed } = await d.file({
    agent: 'mcsecretary',
    brand_id: d.brandId,
    action_type: 'graph_dispatch',
    action_payload,
    reason,
    evidence: {
      requested_by: requestedBy,
      briefs: plan.briefs.length,
      design_runs_estimated,
      vendor_contacts: plan.vendor_contacts.length,
      run_requests: plan.run_requests.length,
    },
    cost_usd: 0,
    reversible: false,
    level_required: 1,
    expires_at,
  });

  // insertProposal de-dupes on the payload hash, so re-sending the same
  // message inside the 48h expiry lands on the existing card. Say which it
  // is: "Filed" on a card that already ran would be a lie. (A deduped PENDING
  // row whose card never reached Telegram is re-sent by the router and comes
  // back as `card`, not `deduped` — that really is a freshly delivered card.)
  if (routed === 'deduped') {
    return getProposalById(d.db, id)?.status === 'executed'
      ? `That dispatch already ran as card #${id}; nothing new was filed.`
      : `Card #${id} is still waiting for your Approve — same dispatch, nothing new was filed.`;
  }

  const held = `${plan.briefs.length} brief(s), ${plan.vendor_contacts.length} vendor contact(s), ${plan.run_requests.length} run request(s)`;
  if (routed === 'card_failed') {
    return `Filed card #${id} (${held}) but the Telegram card did not send — open it from the inbox to Approve.`;
  }
  return `Filed card #${id}: ${held}. Nothing starts until you tap Approve.`;
}

function readAgentOutputs(d: GraphDeps, input: Record<string, unknown>): string {
  const agent = typeof input.agent === 'string' ? input.agent.trim() : '';
  if (!knownAgents(d).includes(agent)) return unknownAgentMessage(d, agent || '(none given)');

  const raw = typeof input.limit === 'number' ? Math.trunc(input.limit) : READ_AGENT_OUTPUTS_DEFAULT;
  const limit = Math.min(Math.max(Number.isFinite(raw) ? raw : READ_AGENT_OUTPUTS_DEFAULT, 1), READ_AGENT_OUTPUTS_MAX);

  const proposals = listProposalsByAgent(d.db, agent, d.brandId, limit).map((r) => {
    const out: Record<string, unknown> = {
      created_at: r.created_at,
      action_type: r.action_type,
      status: r.status,
      reason: r.reason,
    };
    try { out.evidence = JSON.parse(r.evidence); } catch { out.evidence = {}; }
    try {
      const payload = JSON.parse(r.action_payload) as ActionPayload;
      // Only a `notes` proposal carries its text in the body; a hand call's
      // body is a request, not a report, and would just be noise here.
      if (payload.hand === 'notes') out.body = payload.body;
    } catch { /* an unreadable payload still leaves the row's reason usable */ }
    return out;
  });

  const latest_run_at = latestRunStartedAt(d.db, agent, d.brandId);
  const stale = latest_run_at === null || Date.parse(d.now()) - Date.parse(latest_run_at) > STALE_MS;
  return JSON.stringify({ agent, latest_run_at, stale, proposals });
}

async function readHand(d: GraphDeps, input: Record<string, unknown>): Promise<string> {
  const hand = typeof input.hand === 'string' ? input.hand.trim() : '';
  const path = typeof input.path === 'string' ? input.path : '';
  if (!path.startsWith(HAND_READ_PATH_PREFIX)) {
    return `read_hand only reads ${HAND_READ_PATH_PREFIX} paths; got ${path || '(nothing)'}`;
  }
  // `..`/`.` segments would resolve back out of the integration prefix before
  // the request goes out, so the prefix check above would not hold.
  if (path.split('/').some((seg) => seg === '.' || seg === '..')) {
    return `read_hand refuses a path with relative segments; got ${path}`;
  }

  let brand;
  try { brand = loadBrandConfig(d.brandsDir, d.brandId); }
  catch (err) { return `Tool error: ${err instanceof Error ? err.message : String(err)}`; }
  // The built-in hands (notes / email / graph) have no upstream to read.
  if (!Object.hasOwn(brand.hands, hand)) {
    return `Unknown hand: ${hand || '(none given)'}. Hands: ${Object.keys(brand.hands).join(', ')}.`;
  }

  let target: { url: string; bearer: string };
  try { target = resolveHand(brand, hand, d.env); }
  catch (err) { return `Tool error: ${err instanceof Error ? err.message : String(err)}`; }

  const resolved = resolveHandUrl(target.url, path);
  if (!resolved.ok) return resolved.error;

  const res = await d.handFetch(resolved.href, {
    method: 'GET',
    headers: { Authorization: `Bearer ${target.bearer}`, Accept: 'application/json' },
  });
  if (!res.ok) return `${hand} returned ${res.status}.`;
  const text = await res.text();
  return text.length > HAND_READ_CAP_BYTES ? `${text.slice(0, HAND_READ_CAP_BYTES)}…[truncated]` : text;
}

function requestAgentRun(d: GraphDeps, input: Record<string, unknown>): string {
  const agent = typeof input.agent === 'string' ? input.agent.trim() : '';
  if (!knownAgents(d).includes(agent)) return unknownAgentMessage(d, agent || '(none given)');
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (!reason) return 'request_agent_run needs a reason.';

  const type = `${RUN_REQUEST_PREFIX}${agent}`;
  // An undrained request already wakes the agent on the next tick; a second
  // one would only sit on the spine and re-wake it every 15 minutes.
  if (countPendingByType(d.db, [type])[type]!.pending > 0) {
    return `A run request for ${agent} is already queued and undrained — the Mac mini picks it up within 15 minutes.`;
  }
  insertEvent(d.db, {
    source_hand: 'mcsecretary', brand_id: d.brandId, event_type: type,
    payload: { agent, reason, requested_via: 'telegram' }, urgent: true,
  }, d.now());
  return `Requested a fresh ${agent} run; its report card should arrive in about 20 minutes.`;
}

export async function executeGraphTool(
  name: string, input: Record<string, unknown>, userId?: string,
): Promise<string> {
  const d = deps;
  if (!d) return GRAPH_DEPS_MISSING_MESSAGE;
  // Admin-only. A dispatch starts Designer runs, rewrites the vendor registry
  // and sends vendor mail on Approve; a hand read shows the company's cash.
  // An unknown caller is not an admin.
  const user = callingUser(d, userId);
  if (!user?.isAdmin) return GRAPH_NOT_ADMIN_MESSAGE;
  try {
    switch (name) {
      case 'propose_graph_dispatch': return await proposeGraphDispatch(d, input, user.name);
      case 'read_agent_outputs': return readAgentOutputs(d, input);
      case 'read_hand': return await readHand(d, input);
      case 'request_agent_run': return requestAgentRun(d, input);
      default: return `Unknown tool: ${name}`;
    }
  } catch (err) {
    // A hand failure must never bubble into the chat loop's error path.
    return `Tool error: ${err instanceof Error ? err.message : String(err)}`;
  }
}
