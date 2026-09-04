import type Database from 'better-sqlite3';
import { InlineKeyboard } from 'grammy';
import {
  getProposalById, decideProposal, setEditRequested, clearEditRequested, clearEditRequestedForChat,
  findEditRequestedForChat, appendEdit, updateActionPayload,
} from '../db/proposal-queries.js';
import { recordTrustDecision } from '../db/trust-queries.js';
import { parseEdit, applyEdit } from './edits.js';
import { extractNotify, type ExecutionResult } from './executor.js';
import type { ActionPayload, ProposalRow } from './types.js';

export interface CardDeps {
  now: () => string;
  execute: (id: number) => Promise<ExecutionResult>;
  reply: (text: string) => Promise<void>;
}

export type CallbackAction = 'approve' | 'edit' | 'reject';

/** An edit request older than this is dropped; the next message goes to the assistant. */
export const EDIT_WINDOW_MS = 15 * 60 * 1000;

const REASON_CAP = 500;
const EVIDENCE_VALUE_CAP = 80;

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

/** A reply is a courtesy; the ledger and executor must never depend on it landing. */
async function safeReply(deps: CardDeps, text: string): Promise<void> {
  try {
    await deps.reply(text);
  } catch (err) {
    console.error('spine: reply failed', err);
  }
}

function money(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

function cap(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Five-ish lines, phone-readable (spec §4.2). */
export function renderProposalCard(p: ProposalRow): string {
  const payload = JSON.parse(p.action_payload) as ActionPayload;
  const evidence: unknown = JSON.parse(p.evidence);
  const evLines = typeof evidence !== 'object' || evidence === null
    ? []
    : Object.entries(evidence as Record<string, unknown>).slice(0, 3)
      .map(([k, v]) => `  ${k}: ${cap(String(v), EVIDENCE_VALUE_CAP)}`);
  const lines = [
    `#${p.id} ${p.agent} · ${p.brand_id}`,
    `${p.action_type} → ${payload.hand}${payload.path}`,
    cap(p.reason, REASON_CAP),
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

type CallbackResult = { ok: boolean; message: string };

/** ` <notify>` when a successful execution's response body carries one, else ''. */
function notifySuffix(r: ExecutionResult): string {
  if (!r.ok) return '';
  const notify = extractNotify(r.body);
  return notify ? ` ${notify}` : '';
}

/**
 * The status-guarded UPDATE in decideProposal is the claim: whichever tap
 * lands it first owns the trust count and the execution; the other is refused.
 */
async function approveAndExecute(
  db: Database.Database,
  p: ProposalRow,
  status: 'approved' | 'approved_with_edit',
  by: string,
  deps: CardDeps,
): Promise<CallbackResult> {
  if (!decideProposal(db, p.id, status, by, deps.now())) {
    await safeReply(deps, `#${p.id} was already decided.`);
    return { ok: false, message: `#${p.id} was already decided` };
  }
  recordTrustDecision(db, trustKey(p), status, deps.now());
  const r = await deps.execute(p.id);
  await safeReply(deps, r.ok
    ? `Approved #${p.id} — executed (${r.http_status}).${notifySuffix(r)}`
    : `Approved #${p.id} — execution failed${r.http_status ? ` (${r.http_status})` : ''}${r.error ? `: ${r.error}` : ''}.`);
  return { ok: true, message: status };
}

export async function handleProposalCallback(
  db: Database.Database,
  cb: { action: CallbackAction; id: number },
  chatId: string,
  by: string,
  deps: CardDeps,
): Promise<CallbackResult> {
  const p = getProposalById(db, cb.id);
  if (!p) return { ok: false, message: `No proposal #${cb.id}` };
  if (p.telegram_chat_id !== chatId) return { ok: false, message: 'Not your proposal' };
  if (p.status !== 'pending') return { ok: false, message: `#${cb.id} is already ${p.status}` };

  if (cb.action === 'approve') {
    return approveAndExecute(db, p, 'approved', by, deps);
  }
  if (cb.action === 'reject') {
    if (!decideProposal(db, p.id, 'rejected', by, deps.now())) {
      await safeReply(deps, `#${p.id} was already decided.`);
      return { ok: false, message: `#${p.id} was already decided` };
    }
    const t = recordTrustDecision(db, trustKey(p), 'rejected', deps.now());
    await safeReply(deps, `Rejected #${p.id}.${t.demoted ? ' Trust for this action reset to level 1.' : ''}`);
    return { ok: true, message: 'rejected' };
  }
  // A chat waits on at most one edit reply: the newest request wins.
  clearEditRequestedForChat(db, chatId, p.id);
  setEditRequested(db, p.id, deps.now());
  await safeReply(deps, `Editing #${p.id}. Reply with key=value pairs, e.g. monthly_usd=10000 — or "cancel".`);
  return { ok: true, message: 'edit_requested' };
}

/**
 * Called for every text message before the normal assistant flow. Returns true
 * when the text was consumed as an edit reply. An edit request older than
 * EDIT_WINDOW_MS is dropped and the message falls through to the assistant.
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
  const requestedAt = Date.parse(p.edit_requested_at ?? '');
  if (Number.isNaN(requestedAt) || Date.parse(deps.now()) - requestedAt > EDIT_WINDOW_MS) {
    clearEditRequested(db, p.id);
    return false;
  }
  if (text.trim().toLowerCase() === 'cancel') {
    clearEditRequested(db, p.id);
    await safeReply(deps, `Edit cancelled. #${p.id} is still pending.`);
    return true;
  }
  const parsed = parseEdit(text);
  if (!parsed.ok) { await safeReply(deps, `Still editing #${p.id}. ${parsed.reason}`); return true; }
  const applied = applyEdit(JSON.parse(p.action_payload) as ActionPayload, parsed.fields);
  if (!applied.ok) { await safeReply(deps, `Still editing #${p.id}. ${applied.reason}`); return true; }
  if (!updateActionPayload(db, p.id, applied.payload)) {
    await safeReply(deps, `#${p.id} was already decided.`);
    return true;
  }
  appendEdit(db, p.id, { at: deps.now(), note: text.trim() });
  await approveAndExecute(db, { ...p, action_payload: JSON.stringify(applied.payload) }, 'approved_with_edit', by, deps);
  return true;
}
