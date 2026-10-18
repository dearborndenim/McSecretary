import type Database from 'better-sqlite3';
import { getUserById } from '../db/user-queries.js';
import { promoteTrust, TRUST_WILDCARD } from '../db/trust-queries.js';
import type { TrustLevel } from './types.js';

export interface PromoteCommand { agent: string; action_type: string; level: TrustLevel; brand_id: string | undefined }

/**
 * `promote <agent> <action_type> <0-3> [brand=<id>]`. `*` is legal for agent
 * and/or action_type (a wildcard row): `promote * * 2 brand=knits`.
 */
export function parsePromoteCommand(text: string): PromoteCommand | null {
  const m = /^promote\s+(\S+)\s+(\S+)\s+([0-3])(?:\s+brand=(\S+))?\s*$/i.exec(text.trim());
  if (!m) return null;
  return { agent: m[1]!, action_type: m[2]!, level: Number(m[3]) as TrustLevel, brand_id: m[4] };
}

/** Admin-only. Unknown user ids are refused (production always resolves `by` from the Telegram chat). Unknown brands write nothing. */
export function runPromoteCommand(
  db: Database.Database,
  cmd: PromoteCommand,
  defaultBrandId: string,
  brandExists: (brandId: string) => boolean,
  by: string,
  nowIso: string,
): string {
  const user = getUserById(db, by);
  if (!user || user.role !== 'admin') return 'Only an admin can change trust levels.';
  const brand_id = cmd.brand_id ?? defaultBrandId;
  if (!brandExists(brand_id)) return `Unknown brand: ${brand_id}.`;
  const r = promoteTrust(db, { agent: cmd.agent, brand_id, action_type: cmd.action_type }, cmd.level, by, nowIso);
  if (!r.ok) {
    return r.reason === 'pinned'
      ? `${cmd.action_type} is a pinned human gate and stays at level 1.`
      : 'Level must be 0–3.';
  }
  const wildcard = cmd.agent === TRUST_WILDCARD || cmd.action_type === TRUST_WILDCARD;
  return `${cmd.agent} ${cmd.action_type} → level ${r.level} (${brand_id}).${wildcard ? ' Exact rows and pinned gates still win.' : ''}`;
}
