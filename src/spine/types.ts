export type ProposalStatus =
  | 'pending'
  | 'approved'
  | 'approved_with_edit'
  | 'rejected'
  | 'expired'
  | 'executed'
  | 'failed';

export type TrustLevel = 0 | 1 | 2 | 3;

/** What the executor sends to a hand. `hand` must exist in the brand config. */
export interface ActionPayload {
  hand: string;
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  body: Record<string, unknown>;
}

export interface ProposalInput {
  agent: string;
  brand_id: string;
  action_type: string;
  action_payload: ActionPayload;
  reason: string;
  evidence: Record<string, string | number | boolean | null>;
  cost_usd: number;
  reversible: boolean;
  level_required: TrustLevel;
  expires_at: string; // ISO
}

export interface ProposalRow {
  id: number;
  agent: string;
  brand_id: string;
  action_type: string;
  action_payload: string; // JSON
  payload_hash: string;
  reason: string;
  evidence: string; // JSON
  cost_usd: number;
  reversible: number; // 0/1
  level_required: number;
  status: ProposalStatus;
  created_at: string;
  expires_at: string;
  decided_by: string | null;
  decided_at: string | null;
  edits: string | null; // JSON array of {at, note}
  edit_requested_at: string | null;
  execution_result: string | null; // JSON
  telegram_chat_id: string | null;
  telegram_message_id: number | null;
}

export interface SpineEventInput {
  source_hand: string;
  brand_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  urgent: boolean;
}

export interface SpineEventRow {
  id: number;
  source_hand: string;
  brand_id: string;
  event_type: string;
  payload: string;
  urgent: number;
  received_at: string;
  drained_by: string | null;
  drained_at: string | null;
}

export interface TrustRow {
  agent: string;
  brand_id: string;
  action_type: string;
  level: number;
  approved_as_proposed: number;
  approved_with_edit: number;
  rejected: number;
  last_change_at: string | null;
  last_change_by: string | null;
}

export interface OutcomeInput {
  artifact_id: string;
  brand_id: string;
  lane: 'marketing' | 'ops' | 'product';
  attributes: Record<string, string | number | boolean>;
  prediction: Record<string, number> | null;
  metrics: Record<string, number>;
  observed_at: string; // ISO
}

export interface OutcomeRow {
  id: number;
  artifact_id: string;
  brand_id: string;
  lane: string;
  attributes: string;
  prediction: string | null;
  metrics: string;
  observed_at: string;
  matured_at: string;
}

export interface RunIndexInput {
  run_id: string;
  agent: string;
  brand_id: string;
  skill_commit: string;
  model: string;
  started_at: string;
  finished_at: string | null;
  outcome: 'ok' | 'nothing_to_do' | 'contract_violation' | 'hand_error' | 'running';
  notes: string;
}
