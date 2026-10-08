/**
 * `/staff/agents` — the business-agent review (staff admin UI spec §3.3): the
 * same text as `/agentreview` for a 30 / 60 / 90-day window, plus every
 * business agent's trust rows with the level control.
 */

import { listBusinessTrustRows } from '../../../db/review-queries.js';
import { buildAgentReview } from '../../../spine/jobs.js';
import { LEVEL_LEGEND, html, trustControl, type Safe } from '../render.js';
import type { PageCtx } from '../router.js';

export const REVIEW_WINDOWS = [30, 60, 90] as const;

export function renderAgents(ctx: PageCtx, q: URLSearchParams): Safe {
  const asked = Number(q.get('days'));
  const days = (REVIEW_WINDOWS as readonly number[]).includes(asked) ? asked : 30;
  const since = new Date(Date.parse(ctx.nowIso) - days * 86_400_000).toISOString();
  const review = buildAgentReview(ctx.db, since, ctx.nowIso);
  const rows = listBusinessTrustRows(ctx.db);

  return html`<h1>Business agents</h1>
<p class="row">${REVIEW_WINDOWS.map((d) => d === days ? html`<strong>${d} days</strong>` : html`<a href="/staff/agents?days=${d}">${d} days</a>`)}</p>
<pre>${review}</pre>
<h2>Trust</h2><p class="small mute">Levels: ${LEVEL_LEGEND}</p>
${rows.length === 0 ? html`<p class="mute">No trust rows yet.</p>` : html`<table class="stack"><thead><tr><th>Agent</th><th>Action</th><th>Level</th><th>Record</th></tr></thead><tbody>
${rows.map((r) => html`<tr><td data-k="agent">${r.agent}${r.brand_id !== 'dearborn-denim' ? html` <span class="mute small">${r.brand_id}</span>` : ''}</td>
<td data-k="action"><code>${r.action_type}</code></td><td data-k="level">${trustControl(r, 'agents', ctx.csrf)}</td>
<td data-k="record" class="small mute">${r.approved_as_proposed} approved · ${r.approved_with_edit} edited · ${r.rejected} rejected</td></tr>`)}
</tbody></table>`}`;
}
