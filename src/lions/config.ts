/**
 * South Loop Lions schedule checker — configuration.
 *
 * Kept out of `src/config.ts` on purpose: that module calls `required()` for the
 * Azure, Anthropic and Telegram credentials at import time, so anything that
 * imports it is unusable from tests. `lionsConfig(env)` is a pure function of
 * the env map instead.
 */

export interface LionsConfig {
  /** Google Sheets file id of the CPS SCORE! master schedule. */
  sheetId: string;
  /** gid of the "(N6) Crane HS" tab. */
  gid: string;
  /** Our team, exactly as CPS writes it in the sheet (uppercase). */
  team: string;
  /** Venue fallback when a week header carries no venue of its own. */
  venue: string;
  /** Public origin of this service, used for the "Live page" link. May be ''. */
  baseUrl: string;
}

export const LIONS_DEFAULTS = {
  sheetId: '1JHw7GN3iiXqzpEV0RxlYL4Uwk9e87jzRLJqCvC3g53A',
  gid: '974230082',
  team: 'SOUTH LOOP',
  venue: 'Crane HS',
} as const;

type Env = Record<string, string | undefined>;

function opt(env: Env, name: string, fallback: string): string {
  const v = env[name];
  return v === undefined || v.trim() === '' ? fallback : v.trim();
}

export function lionsConfig(env: Env = process.env): LionsConfig {
  return {
    sheetId: opt(env, 'LIONS_SHEET_ID', LIONS_DEFAULTS.sheetId),
    gid: opt(env, 'LIONS_SHEET_GID', LIONS_DEFAULTS.gid),
    team: opt(env, 'LIONS_TEAM', LIONS_DEFAULTS.team).toUpperCase(),
    venue: opt(env, 'LIONS_VENUE', LIONS_DEFAULTS.venue),
    baseUrl: opt(env, 'LIONS_BASE_URL', opt(env, 'BASE_URL', '')).replace(/\/+$/, ''),
  };
}

/** CSV export URL for the configured sheet + tab. */
export function lionsCsvUrl(cfg: LionsConfig): string {
  return `https://docs.google.com/spreadsheets/d/${cfg.sheetId}/export?format=csv&gid=${cfg.gid}`;
}
