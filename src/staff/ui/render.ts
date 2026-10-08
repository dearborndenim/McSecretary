/**
 * HTML for the staff admin UI. Every page is built with the `html` tag below:
 * each interpolated value is escaped by `esc` unless it is itself the output
 * of `html` (a `Safe`). Nothing else writes markup from a value.
 */

import { toMs } from '../../spine/agent-review.js';
import { isPinned } from '../../spine/gates.js';

export class Safe {
  constructor(readonly s: string) {}
  toString(): string { return this.s; }
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** The one escaping helper: text and attribute values alike. */
export function esc(v: unknown): string {
  return String(v).replace(/[&<>"']/g, (c) => ESC[c]!);
}

function part(v: unknown): string {
  if (v instanceof Safe) return v.s;
  if (Array.isArray(v)) return v.map(part).join('');
  if (v === null || v === undefined || v === false) return '';
  return esc(v);
}

/** Tagged template: escapes every interpolation except nested `html` output. */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Safe {
  let out = strings[0]!;
  for (let i = 0; i < values.length; i++) out += part(values[i]) + strings[i + 1]!;
  return new Safe(out);
}

const CHICAGO = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
});

/** A stored timestamp (ISO or SQLite UTC text) in Chicago time; '—' when absent. */
export function chicago(ts: string | null | undefined): string {
  const ms = toMs(ts ?? null);
  return Number.isFinite(ms) ? CHICAGO.format(new Date(ms)) : '—';
}

const PILL_TONES: Record<string, string> = {
  pending: 'wait', approved: 'ok', approved_with_edit: 'ok', executed: 'ok',
  failed: 'bad', rejected: 'bad', expired: 'mute',
};

export function pill(status: string): Safe {
  return html`<span class="pill ${PILL_TONES[status] ?? 'mute'}">${status.replace(/_/g, ' ')}</span>`;
}

/** A boolean attribute (a fixed name, never a value), or nothing. */
export function flag(on: boolean, name: 'checked' | 'selected' | 'disabled'): Safe {
  return new Safe(on ? name : '');
}

export function csrfField(csrf: string): Safe {
  return html`<input type="hidden" name="csrf" value="${csrf}">`;
}

export const LEVEL_LEGEND = '1 asks Robert on a card · 2 runs and reports one line · 3 runs silently · all three are recorded in Activity.';

/** Level 1 / 2 / 3 buttons for one trust-ledger row; the current level is marked, a pinned type cannot go above 1. */
export function trustControl(
  row: { agent: string; brand_id: string; action_type: string; level: number | null },
  back: 'people' | 'agents', csrf: string,
): Safe {
  const pinned = isPinned(row.action_type);
  const buttons = [1, 2, 3].map((n) => html`<button name="level" value="${n}" class="${row.level === n ? 'cur' : ''}" ${flag(pinned && n > 1, 'disabled')}>${n}</button>`);
  return html`<form class="inline" method="post" action="/staff/trust">${csrfField(csrf)}
<input type="hidden" name="agent" value="${row.agent}"><input type="hidden" name="brand_id" value="${row.brand_id}">
<input type="hidden" name="action_type" value="${row.action_type}"><input type="hidden" name="back" value="${back}">
${buttons}${pinned ? html`<span class="mute small">pinned human gate, stays at 1</span>` : ''}</form>`;
}

const CSS = `
:root{--bg:#fff;--fg:#1b1b1f;--mute:#6b6b75;--rule:#e2e2e8;--soft:#f5f5f8;--accent:#3b3b98;
--ok-bg:#e3f4e8;--ok-fg:#1f6b35;--bad-bg:#fbe5e5;--bad-fg:#9b1c1c;--wait-bg:#fdf1d8;--wait-fg:#8a5a00;--mute-bg:#ececf0;--mute-fg:#55555f}
@media (prefers-color-scheme:dark){:root{--bg:#141417;--fg:#e8e8ec;--mute:#9a9aa6;--rule:#2c2c33;--soft:#1d1d22;--accent:#a9a9f0;
--ok-bg:#163d22;--ok-fg:#9fe0b2;--bad-bg:#4a1717;--bad-fg:#f6b0b0;--wait-bg:#47360f;--wait-fg:#f3d48a;--mute-bg:#2a2a31;--mute-fg:#b4b4be}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{max-width:1100px;margin:0 auto;padding:12px 16px 48px}
nav{display:flex;flex-wrap:wrap;gap:4px 16px;align-items:center;padding:10px 16px;border-bottom:1px solid var(--rule)}
nav a{color:var(--fg);text-decoration:none}nav a.on{font-weight:600;border-bottom:2px solid var(--accent)}
nav form{margin-left:auto}
h1{font-size:20px;margin:16px 0 8px}h2{font-size:17px;margin:20px 0 6px}h3{font-size:15px;margin:12px 0 4px}
a{color:var(--accent)}
.mute{color:var(--mute)}.small{font-size:13px}
.notice{padding:8px 12px;border:1px solid var(--rule);background:var(--soft);margin:12px 0}
.notice.err{border-color:var(--bad-fg)}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--rule);vertical-align:top}
th{font-size:13px;color:var(--mute);font-weight:600}
.person{border-top:1px solid var(--rule);padding:8px 0 12px}
.row{display:flex;flex-wrap:wrap;gap:6px 12px;align-items:center;margin:4px 0}
form.inline{display:inline-flex;flex-wrap:wrap;gap:6px;align-items:center;margin:0}
input,select,button{font:inherit;color:var(--fg);background:var(--bg);border:1px solid var(--rule);border-radius:4px;padding:4px 8px}
button{background:var(--soft);cursor:pointer}button[disabled]{opacity:.45;cursor:default}
button.cur{border-color:var(--accent);font-weight:600}
label{white-space:nowrap}
.pill{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;font-weight:600;white-space:nowrap}
.pill.ok{background:var(--ok-bg);color:var(--ok-fg)}.pill.bad{background:var(--bad-bg);color:var(--bad-fg)}
.pill.wait{background:var(--wait-bg);color:var(--wait-fg)}.pill.mute{background:var(--mute-bg);color:var(--mute-fg)}
pre{white-space:pre-wrap;word-break:break-word;background:var(--soft);padding:8px;margin:6px 0;font-size:13px}
details summary{cursor:pointer}
code{font-size:13px}
@media (max-width:600px){
 table.stack thead{display:none}table.stack tr{display:block;border-bottom:1px solid var(--rule);padding:6px 0}
 table.stack td{display:block;border:0;padding:2px 0}
 table.stack td[data-k]::before{content:attr(data-k) ": ";color:var(--mute);font-size:13px}
 nav form{margin-left:0}
}`;

export type NavKey = 'people' | 'activity' | 'agents' | 'catalogue' | null;

export function layout(opts: {
  title: string; nav: NavKey; csrf?: string; notice?: { text: string; error?: boolean } | null; body: Safe;
}): string {
  const link = (key: NavKey, href: string, label: string) => html`<a href="${href}" class="${opts.nav === key ? 'on' : ''}">${label}</a>`;
  const nav = opts.csrf
    ? html`<nav>${link('people', '/staff', 'People')}${link('activity', '/staff/activity', 'Activity')}${link('agents', '/staff/agents', 'Agents')}${link('catalogue', '/staff/catalogue', 'Catalogue')}
<form method="post" action="/staff/logout">${csrfField(opts.csrf)}<button>Sign out</button></form></nav>`
    : html``;
  const notice = opts.notice ? html`<div class="notice ${opts.notice.error ? 'err' : ''}">${opts.notice.text}</div>` : html``;
  return html`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${opts.title} · McSecretary staff</title><style>${new Safe(CSS)}</style></head>
<body>${nav}<main>${notice}${opts.body}</main></body></html>`.s;
}
