/**
 * Wake webhooks (env `SPINE_WAKE_HOOKS`): when `POST /spine/events` queues an event whose type a
 * hook lists, McSecretary POSTs `{"queued": "<type>", "id": <event id>}` to that hook's URL so the
 * drainer (a Grok bot's routine) wakes and drains now instead of on its next schedule. The nudge
 * never carries the event's payload. Best-effort: a failed or slow wake never affects the 200.
 *
 * Shape: a JSON array of `{ types: string[], url: "https://…", key?: string, headers?: {…} }`;
 * `key` is sent as `Authorization: Bearer <key>`. URLs and keys are secrets and are never logged.
 * A malformed value disables wakes with one log line; it never stops the boot (the bots' own
 * schedule still drains).
 */

export interface WakeHook {
  types: string[];
  url: string;
  headers: Record<string, string>;
}

export interface WakeRequest {
  url: string;
  init: RequestInit;
}

const WAKE_TIMEOUT_MS = 10_000;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Never throws. `warn` gets one line per refused entry, never naming the URL or key. */
export function parseWakeHooks(raw: string | undefined, warn: (msg: string) => void = console.warn): WakeHook[] {
  if (!raw || !raw.trim()) return [];
  let doc: unknown;
  try { doc = JSON.parse(raw); } catch { warn('SPINE_WAKE_HOOKS ignored: not valid JSON'); return []; }
  if (!Array.isArray(doc)) { warn('SPINE_WAKE_HOOKS ignored: must be a JSON array'); return []; }
  const hooks: WakeHook[] = [];
  doc.forEach((e, i) => {
    if (!isPlainObject(e)) { warn(`SPINE_WAKE_HOOKS[${i}] ignored: not an object`); return; }
    const types = Array.isArray(e.types) ? e.types.filter((t): t is string => typeof t === 'string' && t.length > 0) : [];
    if (types.length === 0) { warn(`SPINE_WAKE_HOOKS[${i}] ignored: types must list event types`); return; }
    let url: URL | null = null;
    try { url = typeof e.url === 'string' ? new URL(e.url) : null; } catch { /* reported below */ }
    if (!url || url.protocol !== 'https:') { warn(`SPINE_WAKE_HOOKS[${i}] ignored: url must be https`); return; }
    const headers: Record<string, string> = {};
    if (isPlainObject(e.headers)) {
      for (const [k, v] of Object.entries(e.headers)) if (typeof v === 'string') headers[k] = v;
    }
    if (typeof e.key === 'string' && e.key) headers.Authorization = `Bearer ${e.key}`;
    hooks.push({ types, url: e.url as string, headers });
  });
  return hooks;
}

/** The requests one queued event triggers: exact type match, body is the type and id only. */
export function wakeRequests(hooks: WakeHook[], eventType: string, eventId: number): WakeRequest[] {
  const body = JSON.stringify({ queued: eventType, id: eventId });
  return hooks.filter((h) => h.types.includes(eventType)).map((h) => ({
    url: h.url,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...h.headers },
      body,
      redirect: 'error', // a 3xx never carries the key somewhere else
    },
  }));
}

/** Fire-and-forget; logs the event type and the outcome kind only. */
export function makeWaker(
  hooks: WakeHook[],
  doFetch: (url: string, init: RequestInit) => Promise<Response>,
  log: (msg: string) => void = console.log,
): (eventType: string, eventId: number) => void {
  return (eventType, eventId) => {
    for (const r of wakeRequests(hooks, eventType, eventId)) {
      doFetch(r.url, { ...r.init, signal: AbortSignal.timeout(WAKE_TIMEOUT_MS) })
        .then((res) => log(`spine wake ${eventType} #${eventId}: ${res.ok ? 'ok' : `HTTP ${res.status}`}`))
        // err.message may carry the URL: only its kind is logged.
        .catch((err: unknown) => log(`spine wake ${eventType} #${eventId}: failed ${(err as Error)?.name ?? 'error'}`));
    }
  };
}
