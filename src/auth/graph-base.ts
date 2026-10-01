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
