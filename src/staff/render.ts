/**
 * Plain-text renderers for staff look-ups whose hand answers with JSON that
 * is too large or too nested to hand to the chat model as-is (a cs-desk
 * thread can be 100 messages of 8 KB each). A read action names one with
 * `render` in config/staff-actions.json; the executor parses the hand's full
 * 2xx body and hands the model this text instead of the 8 KB-capped JSON.
 * Every renderer's output fits one Telegram message (RENDER_CAP).
 */

import { cap, isPlainObject as isObj } from '../spine/json-object.js';

export const RENDER_CAP = 3500;
/** Messages shown from the end of a thread, before the size budget drops older ones. */
export const THREAD_LAST_MESSAGES = 8;
const MESSAGE_BODY_CAP = 700;
const SUBJECT_CAP = 120;

type Json = Record<string, unknown>;

function str(v: unknown): string {
  return typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v);
}

/** "Oct 10 14:03" in Chicago (cs-desk's customers and staff are on Chicago time). */
function when(iso: unknown): string {
  const t = Date.parse(str(iso));
  if (Number.isNaN(t)) return '';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(t)).replace(',', '');
}

function customerOf(c: unknown): string {
  if (!isObj(c)) return 'unknown customer';
  const name = str(c.name).trim();
  const email = str(c.email).trim();
  if (name && email) return `${name} <${email}>`;
  return name || email || 'unknown customer';
}

/** The new text of an email: quoted history (`>` lines, "On … wrote:" and below) dropped, blank runs collapsed. */
export function cleanBody(text: string): string {
  const out: string[] = [];
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*On .{4,200} wrote:\s*$/.test(line) || /^-{2,}\s*Original Message\s*-{2,}/i.test(line)) break;
    if (/^\s*>/.test(line)) continue;
    out.push(line.trimEnd());
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function who(m: Json): string {
  const author = str(m.author);
  if (author === 'customer') return 'CUSTOMER';
  if (author === 'ai') return 'BOT';
  if (author === 'system') return 'SYSTEM';
  return `STAFF ${str(m.author_id) || 'unknown'}`;
}

function renderMessage(m: Json): string {
  const at = when(m.created_at);
  const head = str(m.kind) === 'note'
    ? `[INTERNAL NOTE by ${who(m)}, not sent to the customer · ${at}]`
    : str(m.direction) === 'in'
      ? `[${who(m)} wrote · ${at}]`
      : `[SENT TO CUSTOMER by ${who(m)} · ${at}]`;
  const body = cap(cleanBody(str(m.body_text)), MESSAGE_BODY_CAP) || '(no text)';
  const atts = Array.isArray(m.attachments) ? m.attachments.filter(isObj).map((a) => str(a.name)).filter(Boolean) : [];
  const attLine = atts.length > 0 ? `\n(${atts.length} attachment${atts.length === 1 ? '' : 's'}: ${cap(atts.join(', '), 120)})` : '';
  return `${head}\n${body}${attLine}`;
}

/**
 * GET /api/integration/tickets/:id/thread → the ticket header and its last
 * messages, oldest first. Internal notes are marked so they are never quoted
 * to the customer as if they had been sent.
 */
export function renderCsThread(json: unknown): string | null {
  if (!isObj(json) || !isObj(json.ticket) || !Array.isArray(json.messages)) return null;
  const t = json.ticket;
  const all = json.messages.filter(isObj);
  const tags = Array.isArray(t.tags) && t.tags.length > 0 ? ` · tags ${t.tags.map(str).join(', ')}` : '';
  const header = [
    `Ticket #${str(t.id)} · ${str(t.status)} · assigned ${str(t.assignee) || 'nobody'} · priority ${str(t.priority) || 'normal'}${tags}`,
    `Customer: ${customerOf(t.customer)}`,
    `Subject: ${cap(str(t.subject) || '(no subject)', SUBJECT_CAP)}`,
  ];
  if (t.merged_into) header.push(`Merged into #${str(t.merged_into)}: reply there, not here.`);

  let shown = all.slice(-THREAD_LAST_MESSAGES).map(renderMessage);
  const build = () => {
    const omitted = all.length - shown.length;
    const intro = all.length === 0
      ? 'No messages.'
      : omitted > 0
        ? `Last ${shown.length} of ${all.length} messages, oldest first (${omitted} earlier not shown):`
        : `${all.length} message${all.length === 1 ? '' : 's'}, oldest first:`;
    return [...header, '', intro, '', shown.join('\n\n')].join('\n').trimEnd();
  };
  let text = build();
  // Drop the oldest shown message until it fits; the newest always stays.
  while (text.length > RENDER_CAP && shown.length > 1) {
    shown = shown.slice(1);
    text = build();
  }
  return cap(text, RENDER_CAP);
}

/** GET /api/integration/tickets → one line per ticket, newest activity first. */
export function renderCsTicketList(json: unknown): string | null {
  if (!isObj(json) || !Array.isArray(json.tickets)) return null;
  const tickets = json.tickets.filter(isObj);
  if (tickets.length === 0) return 'No tickets.';
  const lines = tickets.map((t) => {
    const last = t.last_message_at
      ? ` · ${str(t.last_message_direction) === 'in' ? 'customer wrote' : 'we wrote'} ${when(t.last_message_at)}`
      : '';
    const prio = t.priority && t.priority !== 'normal' ? ` · ${str(t.priority)}` : '';
    return `#${str(t.id)} · ${str(t.status)}${prio} · ${customerOf(t.customer)} · "${cap(str(t.subject) || '(no subject)', 80)}"${last}`;
  });
  const more = json.next_cursor ? '\n(more tickets not shown)' : '';
  const intro = `${tickets.length} ticket${tickets.length === 1 ? '' : 's'}, most recently updated first:`;
  let out = `${intro}\n${lines.join('\n')}${more}`;
  if (out.length > RENDER_CAP) out = `${cap(out, RENDER_CAP - 30)}\n(list cut to fit)`;
  return out;
}

export const RENDERERS: Readonly<Record<string, (json: unknown) => string | null>> = Object.freeze({
  cs_thread: renderCsThread,
  cs_ticket_list: renderCsTicketList,
});

/** Render a hand's 2xx body with the named renderer; null when the body is not the shape it expects. */
export function renderRead(name: string, text: string): string | null {
  const fn = Object.hasOwn(RENDERERS, name) ? RENDERERS[name] : undefined;
  if (!fn) return null;
  let json: unknown;
  try { json = JSON.parse(text); } catch { return null; }
  return fn(json);
}
