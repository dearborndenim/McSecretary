import type Database from 'better-sqlite3';
import { insertProposal, setTelegramRef, getProposalById } from '../db/proposal-queries.js';
import { getTrustLevel } from '../db/trust-queries.js';
import { isPinned } from './gates.js';
import type { ExecutionResult } from './executor.js';
import type { ProposalInput } from './types.js';

export interface RouterDeps {
  now: () => string;
  sendCard: (id: number) => Promise<{ chatId: string; messageId: number }>;
  execute: (id: number) => Promise<ExecutionResult>;
  report: (text: string) => Promise<void>;
  silentBudgetUsd: (brandId: string) => number;
}

export type Routed = 'card' | 'card_failed' | 'executed' | 'executed_silent' | 'execution_failed' | 'deduped';

async function sendCardAndRef(db: Database.Database, id: number, deps: RouterDeps): Promise<boolean> {
  try {
    const ref = await deps.sendCard(id);
    setTelegramRef(db, id, ref.chatId, ref.messageId);
    return true;
  } catch (err) {
    console.error('spine: card send failed', id, err);
    return false;
  }
}

/**
 * File a proposal and route it (spec §4.1 flow):
 *   ledger level >= level_required and not pinned → execute
 *     level 3 + reversible + cost <= silent budget → silent
 *     otherwise → execute and report
 *   else → Telegram card, wait for a human
 * A duplicate of a pending row whose card never landed gets the card re-sent.
 */
export async function fileProposal(
  db: Database.Database,
  input: ProposalInput,
  deps: RouterDeps,
): Promise<{ id: number; routed: Routed }> {
  const { id, deduped } = insertProposal(db, input, deps.now());
  if (deduped) {
    const existing = getProposalById(db, id);
    if (existing?.status === 'pending' && existing.telegram_chat_id === null && await sendCardAndRef(db, id, deps)) {
      return { id, routed: 'card' };
    }
    return { id, routed: 'deduped' };
  }

  const level = getTrustLevel(db, input);
  const auto = !isPinned(input.action_type) && level >= input.level_required && level >= 2;

  if (auto) {
    const silent = level === 3 && input.reversible && input.cost_usd <= deps.silentBudgetUsd(input.brand_id);
    const r = await deps.execute(id);
    const unrecorded = r.ok && r.recorded === false;
    if (silent && r.ok && !unrecorded) return { id, routed: 'executed_silent' };
    const p = getProposalById(db, id)!;
    // The hand has already been called and the row recorded; a lost report must not turn that into a throw.
    try {
      await deps.report(
        unrecorded ? `Executed #${id} ${p.agent} ${p.action_type} on the hand but the result was NOT recorded (row status changed mid-flight). Check the hand.`
        : r.ok ? `Executed #${id} ${p.agent} ${p.action_type} (level ${level}, ${r.http_status}).`
        : `Auto-execution of #${id} ${p.agent} ${p.action_type} failed${r.http_status ? ` (${r.http_status})` : ''}.`);
    } catch (err) {
      console.error('spine: report failed', id, err);
    }
    return { id, routed: r.ok ? 'executed' : 'execution_failed' };
  }

  return { id, routed: await sendCardAndRef(db, id, deps) ? 'card' : 'card_failed' };
}
