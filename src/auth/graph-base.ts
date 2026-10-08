/**
 * Shared Microsoft Graph constants and lazy accessors.
 *
 * This module imports nothing at load time, so a test can import any Graph
 * caller without `src/config.ts` throwing on missing credentials. The token
 * and default mailbox are resolved on first call through dynamic imports.
 */

export const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

/** `getGraphToken()` from `./graph.ts`, loaded on first use. */
export async function lazyGraphToken(): Promise<string> {
  const { getGraphToken } = await import('./graph.js');
  return getGraphToken();
}

/** `OUTLOOK_USER_EMAIL_1`: the mailbox the To Do and calendar-write tools act on when none is given. */
export async function defaultOutlookMailbox(): Promise<string> {
  const { config } = await import('../config.js');
  return config.outlook.email1;
}

/**
 * One Graph URL path segment, percent-encoded so a value can never add a
 * segment (`/`), a query (`?`) or a dot-segment (`..`): an id like
 * `../../rob@.../messages/x` must not walk into another mailbox. `@`, `=` and
 * `+` stay literal (legal in a path segment; mailbox UPNs and base64 ids use
 * them, and Graph has always received them raw).
 */
export function graphSegment(value: string): string {
  if (value === '.' || value === '..') return value.replace(/\./g, '%2E');
  return encodeURIComponent(value).replace(/%40/g, '@').replace(/%3D/g, '=').replace(/%2B/g, '+');
}
