import type Database from 'better-sqlite3';
import { getUserById } from '../db/user-queries.js';
import { getProposalById } from '../db/proposal-queries.js';
import { loadBrandConfig, listBrandIds } from './brand-config.js';
import { executeProposal } from './executor.js';
import { sendHandEmail, type EmailHandRequest, type EmailHandResult } from './email-hand.js';
import { fileProposal } from './router.js';
import {
  renderProposalCard, parseCallbackData, handleProposalCallback, handleEditReply, type CardDeps, type InboxTransport,
} from './telegram-card.js';
import { createSpineRouter } from './api-routes.js';
import { parsePromoteCommand, runPromoteCommand } from './promote-command.js';
import type { ProposalInput } from './types.js';

export interface SpineBuildDeps {
  db: Database.Database;
  /** Telegram today; Teams or a web inbox later. Swapping it touches nothing else. */
  transport: InboxTransport;
  now: () => string;
  env: Record<string, string | undefined>;
  brandsDir: string;
  agentKeys: Map<string, string>;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** Abort a hand call after this long so a hung hand can't wedge a callback. Default 20 s. */
  handTimeoutMs?: number;
  /** Microsoft Graph app token for the built-in `email` hand. Omit to disable sending. */
  getGraphToken?: () => Promise<string>;
}

const DEFAULT_HAND_TIMEOUT_MS = 20_000;

export function buildSpine(d: SpineBuildDeps) {
  const handTimeoutMs = d.handTimeoutMs ?? DEFAULT_HAND_TIMEOUT_MS;
  const fetchWithTimeout = (url: string, init: RequestInit) =>
    d.fetch(url, { ...init, signal: AbortSignal.timeout(handTimeoutMs) });
  const loadBrand = (brandId: string) => loadBrandConfig(d.brandsDir, brandId);
  const chatFor = (brandId: string): string => {
    const user = getUserById(d.db, loadBrand(brandId).inbox_user_id);
    if (!user?.telegram_chat_id) throw new Error(`No Telegram chat for inbox user of ${brandId}`);
    return user.telegram_chat_id;
  };
  const getGraphToken = d.getGraphToken;
  const sendEmail = getGraphToken
    ? (req: EmailHandRequest): Promise<EmailHandResult> =>
        sendHandEmail(d.db, req, { fetch: fetchWithTimeout, getGraphToken, env: d.env, now: d.now })
    : undefined;
  const execute = (id: number) => executeProposal(d.db, id, {
    fetch: fetchWithTimeout, env: d.env, loadBrand, now: d.now, sendEmail,
  });
  const replyTo = (chatId: string) => async (text: string) => { await d.transport.sendText(chatId, text); };

  const file = (input: ProposalInput) => fileProposal(d.db, input, {
    now: d.now,
    execute,
    silentBudgetUsd: (brandId) => loadBrand(brandId).silent_budget_usd,
    report: async (text) => { await d.transport.sendText(chatFor(input.brand_id), text); },
    sendCard: async (id) => {
      const p = getProposalById(d.db, id)!;
      const chatId = chatFor(p.brand_id);
      const sent = await d.transport.sendCard(chatId, renderProposalCard(p), id);
      return { chatId, messageId: sent.message_id };
    },
  });

  const cardDeps = (chatId: string): CardDeps => ({ now: d.now, execute, reply: replyTo(chatId) });

  /** Returns the toast text for answerCallbackQuery. */
  const onCallback = async (data: string, chatId: string, by: string): Promise<string> => {
    const cb = parseCallbackData(data);
    if (!cb) return 'Unknown button';
    const r = await handleProposalCallback(d.db, cb, chatId, by, cardDeps(chatId));
    return r.ok ? `#${cb.id} ${r.message}` : r.message;
  };

  /** True when the text was consumed (edit reply or promote command). */
  const onText = async (chatId: string, text: string, by: string): Promise<boolean> => {
    if (await handleEditReply(d.db, chatId, text, by, cardDeps(chatId))) return true;
    const cmd = parsePromoteCommand(text);
    if (!cmd) return false;
    const brands = listBrandIds(d.brandsDir);
    if (cmd.brand_id === undefined && brands.length > 1) {
      await d.transport.sendText(chatId, 'Several brands configured — add brand=<id>.');
      return true;
    }
    const defaultBrand = brands[0] ?? 'dearborn-denim';
    const brandExists = (id: string) => brands.includes(id);
    await d.transport.sendText(chatId, runPromoteCommand(d.db, cmd, defaultBrand, brandExists, by, d.now()));
    return true;
  };

  const handleHttp = createSpineRouter({
    db: d.db, now: d.now, agentKeys: d.agentKeys, brandsDir: d.brandsDir, file, handFetch: fetchWithTimeout, env: d.env,
  });

  return { file, onCallback, onText, handleHttp, execute };
}

export type Spine = ReturnType<typeof buildSpine>;
