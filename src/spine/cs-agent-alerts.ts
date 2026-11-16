/**
 * The CS bot's outage alerts (dearborn-ai-agents `src/services/health-monitor.ts`, 2026-11-16).
 *
 * When a credential the customer-service bot depends on breaks (the 2026-11-06 Gorgias key reset
 * went unnoticed for ten days), the bot files one `cs_agent_alert` proposal on the built-in `email`
 * hand from its own key, `cs-agent-alerts`, to Robert and Kristina. Robert never taps an outage
 * alert, so the action runs from day one: `seedCsAlertTrust` creates its ledger row at level 2 the
 * first time McSecretary boots with that key (an existing row is never touched, so a demotion
 * sticks).
 *
 * What stops the auto-run path from mailing outsiders: `checkCsAlertProposal`, called on every
 * `POST /spine/proposals` whatever AGENT_POLICY says. The `cs-agent-alerts` key may file only
 * `cs_agent_alert`, only on the `email` hand, only to and cc @dearborndenim.com addresses, with no
 * attachments; and no other key may file `cs_agent_alert` at all. AGENT_POLICY cannot express a
 * recipient rule, which is why this lives in code. The key must also have an AGENT_POLICY entry
 * (RESTRICTED_PREFIXES), which limits its events to the Grok task queues.
 */

import type Database from 'better-sqlite3';
import { ensureInitialTrust } from '../db/trust-queries.js';

export const CS_ALERTS_AGENT = 'cs-agent-alerts';
export const CS_ALERT_ACTION_TYPE = 'cs_agent_alert';
export const CS_ALERT_BRAND_ID = 'dearborn-denim';
export const CS_ALERT_HAND = 'email';
/** Level 2: executes without a card and reports the send to the brand's Telegram chat. */
export const CS_ALERT_TRUST_LEVEL = 2 as const;
export const CS_ALERT_RECIPIENT_DOMAIN = 'dearborndenim.com';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function addresses(v: unknown): unknown[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

/** True for `<local>@dearborndenim.com` exactly (no subdomain, no display name). */
export function isAllowedAlertRecipient(addr: unknown): boolean {
  if (typeof addr !== 'string') return false;
  const a = addr.trim().toLowerCase();
  const at = a.lastIndexOf('@');
  return at > 0 && a.indexOf('@') === at && a.slice(at + 1) === CS_ALERT_RECIPIENT_DOMAIN;
}

/**
 * The refusal message for a proposal that breaks the cs_agent_alert rules, or null when the rules
 * do not apply or are met. `body` is the parsed proposal body before any other validation.
 */
export function checkCsAlertProposal(agent: string, body: Record<string, unknown>): string | null {
  const actionType = body.action_type;
  const isAlertAgent = agent === CS_ALERTS_AGENT;
  const isAlertType = actionType === CS_ALERT_ACTION_TYPE;
  if (!isAlertAgent && !isAlertType) return null;
  if (!isAlertAgent) return `${CS_ALERT_ACTION_TYPE} may be filed only by ${CS_ALERTS_AGENT}`;
  if (!isAlertType) return `${CS_ALERTS_AGENT} may file only ${CS_ALERT_ACTION_TYPE}`;
  if (body.brand_id !== CS_ALERT_BRAND_ID) return `${CS_ALERT_ACTION_TYPE} must be for brand ${CS_ALERT_BRAND_ID}`;
  const ap = body.action_payload;
  if (!isPlainObject(ap) || ap.hand !== CS_ALERT_HAND) return `${CS_ALERT_ACTION_TYPE} must use the ${CS_ALERT_HAND} hand`;
  const mail = isPlainObject(ap.body) ? ap.body : {};
  const recipients = [...addresses(mail.to), ...addresses(mail.cc)];
  if (recipients.length === 0) return `${CS_ALERT_ACTION_TYPE} must name a recipient`;
  if (!recipients.every(isAllowedAlertRecipient)) {
    return `${CS_ALERT_ACTION_TYPE} may only be sent to @${CS_ALERT_RECIPIENT_DOMAIN} addresses`;
  }
  if (addresses(mail.attachments).length > 0) return `${CS_ALERT_ACTION_TYPE} may not carry attachments`;
  return null;
}

/**
 * Creates the `cs-agent-alerts` / `cs_agent_alert` ledger row at level 2 when that key is in
 * AGENT_KEYS and no row exists yet. Returns whether a row was created.
 */
export function seedCsAlertTrust(db: Database.Database, agentNames: Iterable<string>, nowIso: string): boolean {
  if (![...agentNames].includes(CS_ALERTS_AGENT)) return false;
  return ensureInitialTrust(db, { agent: CS_ALERTS_AGENT, brand_id: CS_ALERT_BRAND_ID, action_type: CS_ALERT_ACTION_TYPE }, CS_ALERT_TRUST_LEVEL, nowIso);
}
