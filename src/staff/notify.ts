/**
 * Requester notifications (staff access spec §7.3): when a proposal a staff
 * member filed is decided, executed, fails or expires, that person gets one
 * line on Telegram. The admin's own filings are exempt (Robert already gets
 * the report), and so is any proposal whose `agent` is not a user with a
 * linked chat (every business agent).
 */

import type Database from 'better-sqlite3';
import { getProposalById } from '../db/proposal-queries.js';
import { getUserById } from '../db/user-queries.js';
import type { ProposalRow } from '../spine/types.js';
import type { InboxTransport } from '../spine/telegram-card.js';
import { refusalDetail } from './execute.js';
import { cap } from '../spine/json-object.js';

const SUMMARY_CAP = 200;

/** The chat to tell and the line to send, or null when nobody should hear about this row. */
export function requesterNotice(db: Database.Database, p: ProposalRow): { chatId: string; text: string } | null {
  const user = getUserById(db, p.agent);
  if (!user || user.role === 'admin' || !user.telegram_chat_id) return null;
  // The reason's first line is the action summary the staff action filed.
  const head = `#${p.id} ${cap(p.reason.split('\n')[0] ?? p.action_type, SUMMARY_CAP)}`;
  const edited = p.edits !== null;
  let tail: string;
  switch (p.status) {
    case 'executed':
      tail = edited ? 'approved with an edit by Robert and done.' : 'approved and done.';
      break;
    case 'failed': {
      let detail = 'no detail given';
      try {
        const r = JSON.parse(p.execution_result ?? '{}') as { body?: unknown; error?: string };
        detail = refusalDetail(r.body, r.error);
      } catch { /* default */ }
      tail = `approved, but it failed: ${detail}. Robert has been told.`;
      break;
    }
    case 'approved':
      tail = 'approved.';
      break;
    case 'approved_with_edit':
      tail = 'approved with an edit by Robert.';
      break;
    case 'rejected':
      tail = 'rejected by Robert.';
      break;
    case 'expired':
      tail = 'expired without a decision; ask again if it is still needed.';
      break;
    default:
      return null;
  }
  return { chatId: user.telegram_chat_id, text: `${head} — ${tail}` };
}

/** Send the requester their line for proposal `id`. Never throws: a lost notice must not undo a decision. */
export async function notifyRequester(db: Database.Database, transport: InboxTransport, id: number): Promise<void> {
  try {
    const p = getProposalById(db, id);
    if (!p) return;
    const notice = requesterNotice(db, p);
    if (notice) await transport.sendText(notice.chatId, notice.text);
  } catch (err) {
    console.error('staff: requester notice failed', id, err);
  }
}
