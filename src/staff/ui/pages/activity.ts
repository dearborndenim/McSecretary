/**
 * `/staff/activity` — what staff did through the spine (staff admin UI spec
 * §3.2): every proposal filed by a person, newest first, 50 a page, with a CSV
 * export of the same filter.
 */

import { getAllUsers } from '../../../db/user-queries.js';
import { listStaffProposals, STAFF_PAGE_SIZE, type StaffProposalFilter } from '../../../db/proposal-queries.js';
import { extractNotify } from '../../../spine/executor.js';
import type { ProposalRow, ProposalStatus } from '../../../spine/types.js';
import { refusalDetail } from '../../execute.js';
import { chicago, flag, html, pill, type Safe } from '../render.js';
import type { PageCtx } from '../router.js';

export const STATUSES: ProposalStatus[] = ['pending', 'approved', 'approved_with_edit', 'executed', 'failed', 'rejected', 'expired'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RESULT_CAP = 120;
const CSV_MAX_ROWS = 10_000;

/** Offset of America/Chicago from UTC at `ms`, in ms (negative: -5 h or -6 h). */
function chicagoOffsetMs(ms: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms));
  const n = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second')) - Math.floor(ms / 1000) * 1000;
}

/** Midnight at the start of a Chicago calendar day (YYYY-MM-DD), as an ISO instant; null when malformed. */
export function chicagoDayStartIso(day: string): string | null {
  if (!DATE_RE.test(day)) return null;
  const utcMidnight = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(utcMidnight)) return null;
  let ms = utcMidnight - chicagoOffsetMs(utcMidnight);
  ms = utcMidnight - chicagoOffsetMs(ms); // second pass settles a DST change
  return new Date(ms).toISOString();
}

function nextDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

export interface ActivityQuery {
  filter: StaffProposalFilter;
  page: number;
  /** The raw form values, echoed back into the filter form and links. */
  form: { person: string; type: string; status: string; from: string; to: string };
}

/** Query-string filters → a StaffProposalFilter. Unknown or malformed values are ignored. `to` is inclusive. */
export function parseActivityQuery(q: URLSearchParams): ActivityQuery {
  const form = {
    person: q.get('person') ?? '', type: q.get('type') ?? '', status: q.get('status') ?? '',
    from: q.get('from') ?? '', to: q.get('to') ?? '',
  };
  const filter: StaffProposalFilter = {};
  if (form.person) filter.agent = form.person;
  if (form.type) filter.actionType = form.type;
  if ((STATUSES as string[]).includes(form.status)) filter.status = form.status as ProposalStatus;
  const from = chicagoDayStartIso(form.from);
  if (from) filter.fromIso = from;
  const to = DATE_RE.test(form.to) ? chicagoDayStartIso(nextDay(form.to)) : null;
  if (to) filter.toIso = to;
  const page = Number.parseInt(q.get('page') ?? '1', 10);
  return { filter, page: Number.isFinite(page) && page > 0 ? page : 1, form };
}

function parse(json: string | null): unknown {
  if (!json) return null;
  try { return JSON.parse(json); } catch { return json; }
}

/** First line of the reason: the action summary. */
function summaryOf(p: ProposalRow): string {
  return p.reason.split('\n', 1)[0] ?? '';
}

/** The hand's notify line or its error, capped. */
export function resultOf(p: ProposalRow): string {
  const r = parse(p.execution_result) as { ok?: boolean; body?: unknown; error?: string; http_status?: number } | null;
  if (!r || typeof r !== 'object') return '';
  let text: string;
  if (r.ok === false || p.status === 'failed') {
    text = refusalDetail(r.body, r.error ?? (r.http_status ? `failed (${r.http_status})` : 'failed'));
  } else {
    text = extractNotify(r.body) ?? 'done';
  }
  return text.length > RESULT_CAP ? `${text.slice(0, RESULT_CAP - 1)}…` : text;
}

/** Evidence with request_text first. */
function evidenceOrdered(p: ProposalRow): unknown {
  const e = parse(p.evidence);
  if (!e || typeof e !== 'object' || Array.isArray(e)) return e;
  const { request_text, ...rest } = e as Record<string, unknown>;
  return request_text === undefined ? rest : { request_text, ...rest };
}

function pretty(v: unknown): string {
  return v === null || v === undefined ? '—' : JSON.stringify(v, null, 2);
}

function linkFor(form: ActivityQuery['form'], extra: Record<string, string>, base = '/staff/activity'): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...form, ...extra })) if (v) q.set(k, v);
  const s = q.toString();
  return s ? `${base}?${s}` : base;
}

export function renderActivity(ctx: PageCtx, q: URLSearchParams): Safe {
  const aq = parseActivityQuery(q);
  const { rows, total } = listStaffProposals(ctx.db, aq.filter, aq.page);
  const users = getAllUsers(ctx.db);
  const names = new Map(users.map((u) => [u.id, u.name]));
  const types = (ctx.db.prepare('SELECT DISTINCT action_type FROM proposals WHERE agent IN (SELECT id FROM users) ORDER BY action_type').all() as { action_type: string }[]).map((r) => r.action_type);
  const pages = Math.max(1, Math.ceil(total / STAFF_PAGE_SIZE));
  const f = aq.form;

  const filters = html`<form class="row" method="get" action="/staff/activity">
<select name="person"><option value="">Everyone</option>${users.map((u) => html`<option value="${u.id}" ${flag(f.person === u.id, 'selected')}>${u.name}</option>`)}</select>
<select name="type"><option value="">Any action</option>${types.map((t) => html`<option value="${t}" ${flag(f.type === t, 'selected')}>${t}</option>`)}</select>
<select name="status"><option value="">Any status</option>${STATUSES.map((s) => html`<option value="${s}" ${flag(f.status === s, 'selected')}>${s.replace(/_/g, ' ')}</option>`)}</select>
<label>From <input type="date" name="from" value="${f.from}"></label><label>To <input type="date" name="to" value="${f.to}"></label>
<button>Filter</button><a href="/staff/activity">Clear</a></form>`;

  const body = rows.map((p) => html`<tr>
<td data-k="when">${chicago(p.created_at)}<div class="mute small">#${p.id}</div></td>
<td data-k="who">${names.get(p.agent) ?? p.agent}</td>
<td data-k="action"><details><summary>${summaryOf(p)}</summary>
<div class="small mute">${p.action_type}</div>
<h3>Evidence</h3><pre>${pretty(evidenceOrdered(p))}</pre>
<h3>Payload</h3><pre>${pretty(parse(p.action_payload))}</pre>
<h3>Result</h3><pre>${pretty(parse(p.execution_result))}</pre></details></td>
<td data-k="status">${pill(p.status)}</td>
<td data-k="decided by">${p.decided_by ?? (p.status === 'executed' || p.status === 'failed' ? 'trust ledger' : '—')}${p.decided_at ? html`<div class="mute small">${chicago(p.decided_at)}</div>` : ''}</td>
<td data-k="result" class="small">${resultOf(p)}</td></tr>`);

  return html`<h1>Activity</h1>${filters}
<p class="small mute">${total} request${total === 1 ? '' : 's'} · page ${aq.page} of ${pages} · <a href="${linkFor(f, {}, '/staff/activity.csv')}">Download CSV</a></p>
${rows.length === 0 ? html`<p class="mute">Nothing matches.</p>`
    : html`<table class="stack"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Status</th><th>Decided by</th><th>Result</th></tr></thead><tbody>${body}</tbody></table>`}
<p class="row">${aq.page > 1 ? html`<a href="${linkFor(f, { page: String(aq.page - 1) })}">← Newer</a>` : ''}
${aq.page < pages ? html`<a href="${linkFor(f, { page: String(aq.page + 1) })}">Older →</a>` : ''}</p>`;
}

/** One CSV cell: quoted, and a leading = + - @ is defused so a spreadsheet never evaluates it. */
function cell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export function activityCsv(ctx: PageCtx, q: URLSearchParams): string {
  const aq = parseActivityQuery(q);
  const { rows } = listStaffProposals(ctx.db, aq.filter, 1, CSV_MAX_ROWS);
  const names = new Map(getAllUsers(ctx.db).map((u) => [u.id, u.name]));
  const header = ['id', 'created_chicago', 'created_utc', 'person', 'action_type', 'status', 'decided_by', 'decided_at_utc', 'summary', 'request_text', 'result'];
  const lines = rows.map((p) => {
    const ev = parse(p.evidence) as Record<string, unknown> | null;
    return [
      p.id, chicago(p.created_at), p.created_at, names.get(p.agent) ?? p.agent, p.action_type, p.status,
      p.decided_by, p.decided_at, summaryOf(p), ev && typeof ev === 'object' ? ev.request_text : '', resultOf(p),
    ].map(cell).join(',');
  });
  return [header.map(cell).join(','), ...lines].join('\r\n') + '\r\n';
}
