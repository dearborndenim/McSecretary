import type Database from 'better-sqlite3';
import { InlineKeyboard } from 'grammy';
import {
  getProposalById, decideProposal, setEditRequested, clearEditRequestedForChat,
  findEditRequestedForChat, appendEdit, updateActionPayload,
} from '../db/proposal-queries.js';
import { recordTrustDecision } from '../db/trust-queries.js';
import { parseEdit, applyEdit } from './edits.js';
import type { ExecutionResult } from './executor.js';
import type { ActionPayload, ProposalRow } from './types.js';

export interface CardDeps {
  now: () => string;
  execute: (id: number) => Promise<ExecutionResult>;
  reply: (text: string) => Promise<void>;
}

export type CallbackAction = 'approve' | 'edit' | 'reject';

/**
 * The inbox transport. Everything Telegram-specific lives behind this, so a
 * Teams Adaptive Card or web inbox transport can replace it per brand without
 * touching the router, ledger, or executor. Callbacks from any transport
 * arrive as the string `prop:<approve|edit|reject>:<id>` (see parseCallbackData).
 */
export interface InboxTransport {
  /** Deliver a proposal card with Approve / Edit / Reject controls. */
  sendCard(chatId: string, text: string, proposalId: number): Promise<{ message_id: number }>;
  /** Plain text reply or report. */
  sendText(chatId: string, text: string): Promise<void>;
}

/** The slice of grammy's `bot.api` the Telegram transport needs. */
export interface TelegramApiLike {
  sendMessage(chatId: string, text: string, opts?: { reply_markup?: unknown }): Promise<{ message_id: number }>;
}

export function createTelegramTransport(api: TelegramApiLike): InboxTransport {
  return {
    async sendCard(chatId, text, proposalId) {
      return api.sendMessage(chatId, text, { reply_markup: buildProposalKeyboard(proposalId) });
    },
    async sendText(chatId, text) {
      await api.sendMessage(chatId, text);
    },
  };
}

function money(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

/** Five-ish lines, phone-readable (spec §4.2). */
export function renderProposalCard(p: ProposalRow): string {
  const payload = JSON.parse(p.action_payload) as ActionPayload;
  const evidence = JSON.parse(p.evidence) as Record<string, unknown>;
  const evLines = Object.entries(evidence).slice(0, 3).map(([k, v]) => `  ${k}: ${String(v)}`);
  const lines = [
    `#${p.id} ${p.agent} · ${p.brand_id}`,
    `${p.action_type} → ${payload.hand}${payload.path}`,
    p.reason,
    ...evLines,
    `Cost: ${money(p.cost_usd)}${p.reversible ? ' · reversible' : ' · NOT reversible'}`,
    `Expires ${p.expires_at.slice(0, 16).replace('T', ' ')}Z`,
  ];
  return lines.join('\n');
}

export function buildProposalKeyboard(id: number): InlineKeyboard {
  return new InlineKeyboard()
    .text('Approve', `prop:approve:${id}`)
    .text('Edit', `prop:edit:${id}`)
    .text('Reject', `prop:reject:${id}`);
}

export function parseCallbackData(data: string): { action: CallbackAction; id: number } | null {
  const m = /^prop:(approve|edit|reject):(\d+)$/.exec(data);
  if (!m) return null;
  return { action: m[1] as CallbackAction, id: Number(m[2]) };
}

function trustKey(p: ProposalRow) {
  return { agent: p.agent, brand_id: p.brand_id, action_type: p.action_type };
}

async function approveAndExecute(
  db: Database.Database,
  p: ProposalRow,
  status: 'approved' | 'approved_with_edit',
  by: string,
  deps: CardDeps,
): Promise<void> {
  decideProposal(db, p.id, status, by, deps.now());
  recordTrustDecision(db, trustKey(p), status, deps.now());
  const r = await deps.execute(p.id);
  await deps.reply(r.ok
    ? `Approved #${p.id} — executed (${r.http_status}).`
    : `Approved #${p.id} — execution failed${r.http_status ? ` (${r.http_status})` : ''}${r.error ? `: ${r.error}` : ''}.`);
}

export async function handleProposalCallback(
  db: Database.Database,
  cb: { action: CallbackAction; id: number },
  by: string,
  deps: CardDeps,
): Promise<{ ok: boolean; message: string }> {
  const p = getProposalById(db, cb.id);
  if (!p) return { ok: false, message: `No proposal #${cb.id}` };
  if (p.status !== 'pending') return { ok: false, message: `#${cb.id} is already ${p.status}` };

  if (cb.action === 'approve') {
    await approveAndExecute(db, p, 'approved', by, deps);
    return { ok: true, message: 'approved' };
  }
  if (cb.action === 'reject') {
    decideProposal(db, p.id, 'rejected', by, deps.now());
    const t = recordTrustDecision(db, trustKey(p), 'rejected', deps.now());
    await deps.reply(`Rejected #${p.id}.${t.demoted ? ' Trust for this action reset to level 1.' : ''}`);
    return { ok: true, message: 'rejected' };
  }
  // A chat waits on at most one edit reply: the newest request wins.
  clearEditRequestedForChat(db, p.telegram_chat_id ?? '', p.id);
  setEditRequested(db, p.id, deps.now());
  await deps.reply(`Editing #${p.id}. Reply with key=value pairs, e.g. monthly_usd=10000`);
  return { ok: true, message: 'edit_requested' };
}

/**
 * Called for every text message before the normal assistant flow. Returns true
 * when the text was consumed as an edit reply.
 */
export async function handleEditReply(
  db: Database.Database,
  chatId: string,
  text: string,
  by: string,
  deps: CardDeps,
): Promise<boolean> {
  const p = findEditRequestedForChat(db, chatId);
  if (!p) return false;
  const parsed = parseEdit(text);
  if (!parsed.ok) { await deps.reply(`Still editing #${p.id}. ${parsed.reason}`); return true; }
  const applied = applyEdit(JSON.parse(p.action_payload) as ActionPayload, parsed.fields);
  if (!applied.ok) { await deps.reply(`Still editing #${p.id}. ${applied.reason}`); return true; }
  updateActionPayload(db, p.id, applied.payload);
  appendEdit(db, p.id, { at: deps.now(), note: text.trim() });
  await approveAndExecute(db, { ...p, action_payload: JSON.stringify(applied.payload) }, 'approved_with_edit', by, deps);
  return true;
}
