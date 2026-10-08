/**
 * `/staff/catalogue` — read-only view of config/staff-actions.json (staff
 * admin UI spec §3.4). The file is edited in the repo, not here.
 */

import { html, type Safe } from '../render.js';
import type { PageCtx } from '../router.js';

export function renderCatalogue(ctx: PageCtx): Safe {
  const cat = ctx.catalogue;
  return html`<h1>Catalogue</h1>
<p class="small mute">What each group can do. Edited in <code>config/staff-actions.json</code>, not here.</p>
${Object.entries(cat.groups).map(([g, ids]) => html`<h2>${g}</h2>
<table class="stack"><thead><tr><th>Action</th><th>Kind</th><th>Hand</th><th>Reversible</th><th>Starts at</th></tr></thead><tbody>
${ids.map((id) => {
    const a = cat.actions[id]!;
    const write = a.kind === 'write';
    return html`<tr><td data-k="action"><code>${id}</code><div class="small mute">${a.description}</div></td>
<td data-k="kind">${a.kind}</td><td data-k="hand">${a.hand}</td>
<td data-k="reversible">${write ? (a.reversible ? 'yes' : 'no') : '—'}</td>
<td data-k="starts at">${write ? `level ${a.initial_level ?? 1}` : '—'}</td></tr>`;
  })}
</tbody></table>`)}`;
}
