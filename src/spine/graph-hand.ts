/**
 * The built-in `graph` hand (spec §1.3): the third hand beside `notes` and
 * `email`. It makes no HTTP call — executing an approved `graph_dispatch`
 * turns the plan on the proposal body into spine events the Mac mini's urgent
 * poll drains. Nothing in the graph starts until Robert taps Approve, and the
 * body is re-validated here so an edited card cannot smuggle a different plan
 * past the validator the chat tool ran.
 *
 * A brand may register its own `graph` hand in config to override this.
 */

import type Database from 'better-sqlite3';
import { insertEvent } from '../db/event-queries.js';
import { validateDispatchPlan, type DispatchPlan } from './graph-plan.js';

export const GRAPH_DISPATCH_PATH = '/dispatch';
export const RUN_REQUEST_PREFIX = 'run_request_';

/** Source hand stamped on every event this hand emits. */
const SOURCE_HAND = 'mcsecretary';

export function validateGraphPayload(
  p: { method: unknown; path: unknown; body: Record<string, unknown> },
  nowIso: string = new Date().toISOString(),
): { ok: true; plan: DispatchPlan } | { ok: false; error: string } {
  if (p.method !== 'POST') return { ok: false, error: "action_payload.method must be POST for hand 'graph'" };
  if (p.path !== GRAPH_DISPATCH_PATH) {
    return { ok: false, error: `action_payload.path must be '${GRAPH_DISPATCH_PATH}' for hand 'graph'` };
  }
  return validateDispatchPlan(p.body, nowIso);
}

export interface GraphDispatchResult {
  ok: true;
  design_requests: number;
  vendor_contacts: number;
  run_requests: number;
  event_ids: number[];
}

/**
 * Insert the events an approved plan stands for: one `design_request` per
 * brief, one `vendor_contact` per contact, one `run_request_<agent>` per run
 * request. All urgent, all sourced to `mcsecretary`, all carrying the card id
 * so a downstream run can be traced back to the message that asked for it.
 */
export function runGraphDispatch(
  db: Database.Database,
  args: { proposalId: number; brandId: string; plan: DispatchPlan; nowIso: string },
): GraphDispatchResult {
  const { proposalId, brandId, plan, nowIso } = args;
  const event_ids: number[] = [];
  const emit = (event_type: string, payload: Record<string, unknown>): void => {
    event_ids.push(insertEvent(db, {
      source_hand: SOURCE_HAND, brand_id: brandId, event_type, payload, urgent: true,
    }, nowIso));
  };

  for (const brief of plan.briefs) {
    emit('design_request', {
      ...brief,
      persona: brief.persona || 'all',
      brand: brandId,
      as_of: nowIso,
      dispatch_proposal_id: proposalId,
    });
  }
  for (const contact of plan.vendor_contacts) {
    emit('vendor_contact', { ...contact, dispatch_proposal_id: proposalId });
  }
  for (const request of plan.run_requests) {
    emit(`${RUN_REQUEST_PREFIX}${request.agent}`, {
      agent: request.agent,
      reason: request.reason,
      requested_via: 'telegram',
      dispatch_proposal_id: proposalId,
    });
  }

  return {
    ok: true,
    design_requests: plan.briefs.length,
    vendor_contacts: plan.vendor_contacts.length,
    run_requests: plan.run_requests.length,
    event_ids,
  };
}
