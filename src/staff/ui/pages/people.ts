/**
 * `/staff` — People (staff admin UI spec §3.1): every member's groups,
 * location, language, invite codes and trust rows. Writes go through the same
 * query helpers the Telegram commands use.
 */

import crypto from 'node:crypto';
import {
  createInvite, createUser, getAllUsers, getUserByEmail, getUserById, getUserGrants,
  setUserGrants, setUserLanguage, setUserLocation, LANGUAGE_TAG_RE, type User,
} from '../../../db/user-queries.js';
import { listTrustRowsForAgent } from '../../../db/trust-queries.js';
import { loadBrandConfig, type BrandConfig } from '../../../spine/brand-config.js';
import { resolveLocationArg } from '../../admin-commands.js';
import type { StaffCatalogue } from '../../catalogue.js';
import { LEVEL_LEGEND, chicago, csrfField, flag, html, trustControl, type Safe } from '../render.js';
import type { PageCtx, PostResult } from '../router.js';

const EMAIL_RE = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/;
const NAME_MAX = 100;

function brandOf(ctx: PageCtx, cache: Map<string, BrandConfig | null>, id: string): BrandConfig | null {
  if (!cache.has(id)) {
    try { cache.set(id, loadBrandConfig(ctx.brandsDir, id)); } catch { cache.set(id, null); }
  }
  return cache.get(id)!;
}

/** store / factory / none, or the raw gid when it is neither alias. */
function locationAlias(u: User, brand: BrandConfig | null): string {
  if (!u.location_id) return 'none';
  if (brand?.store_location_id === u.location_id) return 'store';
  if (brand?.location_id === u.location_id) return 'factory';
  return u.location_id;
}

/** action_type → the catalogue description of the write that files it. */
function writeDescriptions(cat: StaffCatalogue): Map<string, { id: string; description: string; initial: number }> {
  const m = new Map<string, { id: string; description: string; initial: number }>();
  for (const a of Object.values(cat.actions)) {
    if (a.kind === 'write' && a.action_type) m.set(a.action_type, { id: a.id, description: a.description, initial: a.initial_level ?? 1 });
  }
  return m;
}

function firstSentence(s: string): string {
  const i = s.indexOf('. ');
  return i > 0 ? s.slice(0, i + 1) : s;
}

function personBlock(ctx: PageCtx, u: User, brand: BrandConfig | null, stats: { n: number; last: string | null } | undefined): Safe {
  const cat = ctx.catalogue;
  const groups = new Set(getUserGrants(u));
  const loc = locationAlias(u, brand);
  const descs = writeDescriptions(cat);
  const rows = listTrustRowsForAgent(ctx.db, u.id);
  const have = new Set(rows.map((r) => `${r.brand_id}/${r.action_type}`));
  // Writes in the person's groups that they have not filed yet: shown so a
  // level can be set before the first request.
  const granted = [...groups].flatMap((g) => cat.groups[g] ?? []);
  const unfiled = [...new Set(granted)]
    .map((id) => cat.actions[id]!)
    .filter((a) => a.kind === 'write' && a.action_type && !have.has(`${u.brand_id}/${a.action_type}`));

  const trustRows = [
    ...rows.map((r) => html`<tr><td data-k="action"><code>${r.action_type}</code><div class="mute small">${firstSentence(descs.get(r.action_type)?.description ?? '')}</div></td>
<td data-k="level">${trustControl(r, 'people', ctx.csrf)}</td>
<td data-k="record" class="small mute">${r.approved_as_proposed} approved · ${r.approved_with_edit} edited · ${r.rejected} rejected${r.last_change_by ? html`<br>last set by ${r.last_change_by} ${chicago(r.last_change_at)}` : ''}</td></tr>`),
    ...unfiled.map((a) => html`<tr><td data-k="action"><code>${a.action_type}</code><div class="mute small">${firstSentence(a.description)}</div></td>
<td data-k="level">${trustControl({ agent: u.id, brand_id: u.brand_id, action_type: a.action_type!, level: null }, 'people', ctx.csrf)}</td>
<td data-k="record" class="small mute">not filed yet; starts at ${a.initial_level ?? 1}</td></tr>`),
  ];

  const hidden = html`${csrfField(ctx.csrf)}<input type="hidden" name="user_id" value="${u.id}">`;
  return html`<section class="person">
<h2>${u.name} <span class="mute small">${u.email}</span></h2>
<div class="row small mute">Telegram ${u.telegram_chat_id ? 'linked' : 'not linked'} · ${stats?.n ?? 0} request${stats?.n === 1 ? '' : 's'} in 30 days · last ${chicago(stats?.last)} · brand ${u.brand_id}</div>
<form class="row" method="post" action="/staff/people/grants">${hidden}<span>Groups:</span>
${Object.keys(cat.groups).map((g) => html`<label><input type="checkbox" name="groups" value="${g}" ${flag(groups.has(g), 'checked')}> ${g}</label>`)}
<button>Save groups</button></form>
<div class="row">
<form class="inline" method="post" action="/staff/people/location">${hidden}<span>Location:</span>
<select name="where">${['store', 'factory', 'none'].map((o) => html`<option value="${o}" ${flag(loc === o, 'selected')}>${o}</option>`)}
${['store', 'factory', 'none'].includes(loc) ? '' : html`<option value="${loc}" selected>${loc}</option>`}</select><button>Set</button></form>
<form class="inline" method="post" action="/staff/people/language">${hidden}<span>Language:</span>
<input name="language" value="${u.language ?? ''}" size="6" placeholder="as written"><button>Set</button></form>
<form class="inline" method="post" action="/staff/people/invite">${hidden}<button>New invite code</button></form>
</div>
${trustRows.length > 0
    ? html`<table class="stack"><thead><tr><th>Action</th><th>Level</th><th>Record</th></tr></thead><tbody>${trustRows}</tbody></table>`
    : html`<p class="mute small">No write actions in their groups.</p>`}
</section>`;
}

export function renderPeople(ctx: PageCtx): Safe {
  const users = getAllUsers(ctx.db);
  const members = users.filter((u) => u.role === 'member').sort((a, b) => a.name.localeCompare(b.name));
  const admins = users.filter((u) => u.role !== 'member');
  const since = new Date(Date.parse(ctx.nowIso) - 30 * 86_400_000).toISOString();
  const stats = new Map((ctx.db.prepare(`
    SELECT agent, SUM(created_at >= ?) AS n, MAX(created_at) AS last FROM proposals
    WHERE agent IN (SELECT id FROM users) GROUP BY agent
  `).all(since) as { agent: string; n: number; last: string | null }[]).map((r) => [r.agent, r]));
  const brands = new Map<string, BrandConfig | null>();

  return html`<h1>People</h1>
<p class="small mute">Levels: ${LEVEL_LEGEND}</p>
${members.length === 0 ? html`<p class="mute">No staff yet.</p>` : members.map((u) => personBlock(ctx, u, brandOf(ctx, brands, u.brand_id), stats.get(u.id)))}
<section class="person"><h2>Add person</h2>
<form class="row" method="post" action="/staff/people/add">${csrfField(ctx.csrf)}
<input name="name" placeholder="Name" required maxlength="${NAME_MAX}">
<input name="email" type="email" placeholder="Email" required>
<input name="brand" value="dearborn-denim" size="14"><button>Add and make invite code</button></form></section>
<p class="small mute">Admins (not editable here): ${admins.map((a) => a.name).join(', ') || 'none'}.</p>`;
}

// ── writes ───────────────────────────────────────────────────

function member(ctx: PageCtx, id: string): User | null {
  const u = getUserById(ctx.db, id);
  return u && u.role === 'member' ? u : null;
}

const NO_MEMBER: PostResult = { notice: { text: 'No such staff member.', error: true }, back: 'people' };

export function postPeople(ctx: PageCtx, action: string, form: URLSearchParams): PostResult {
  const db = ctx.db;
  if (action === 'add') {
    const name = (form.get('name') ?? '').trim();
    const email = (form.get('email') ?? '').trim().toLowerCase();
    const brandId = (form.get('brand') ?? '').trim() || 'dearborn-denim';
    if (!name || name.length > NAME_MAX) return { notice: { text: 'Name is required (at most 100 characters).', error: true }, back: 'people' };
    if (!EMAIL_RE.test(email) || email.length > 200) return { notice: { text: 'That email does not look right.', error: true }, back: 'people' };
    if (getUserByEmail(db, email)) return { notice: { text: `${email} is already a user.`, error: true }, back: 'people' };
    try { loadBrandConfig(ctx.brandsDir, brandId); } catch { return { notice: { text: `Unknown brand ${brandId}.`, error: true }, back: 'people' }; }
    const id = crypto.randomUUID();
    const code = db.transaction(() => {
      createUser(db, { id, name, email, role: 'member', brand_id: brandId });
      const c = createInvite(db, id);
      ctx.audit('add_user', id, { name, email, brand_id: brandId });
      return c;
    })();
    return { notice: { text: `Added ${name}. Invite code (shown once): ${code} — they send /start ${code} to the bot. It expires in 7 days.` }, back: 'people' };
  }

  const u = member(ctx, form.get('user_id') ?? '');
  if (!u) return NO_MEMBER;

  if (action === 'grants') {
    const groups = [...new Set(form.getAll('groups'))];
    const bad = groups.filter((g) => !Object.hasOwn(ctx.catalogue.groups, g));
    if (bad.length > 0) return { notice: { text: `Unknown group(s): ${bad.join(', ')}.`, error: true }, back: 'people' };
    db.transaction(() => {
      setUserGrants(db, u.id, groups);
      ctx.audit('set_grants', u.id, { before: getUserGrants(u), after: groups });
    })();
    return { notice: { text: `${u.name}: groups ${groups.length > 0 ? groups.join(', ') : '(none)'}.` }, back: 'people' };
  }
  if (action === 'location') {
    const r = resolveLocationArg(form.get('where') ?? '', u.brand_id, ctx.brandsDir);
    if (!r.ok) return { notice: { text: r.message, error: true }, back: 'people' };
    db.transaction(() => {
      setUserLocation(db, u.id, r.locationId);
      ctx.audit('set_location', u.id, { before: u.location_id, after: r.locationId });
    })();
    return { notice: { text: `${u.name}: location ${form.get('where')}.` }, back: 'people' };
  }
  if (action === 'language') {
    const raw = (form.get('language') ?? '').trim();
    if (raw && !LANGUAGE_TAG_RE.test(raw)) return { notice: { text: 'Language must be a BCP-47 tag like es or pt-BR, or blank.', error: true }, back: 'people' };
    const language = raw || null;
    db.transaction(() => {
      setUserLanguage(db, u.id, language);
      ctx.audit('set_language', u.id, { before: u.language, after: language });
    })();
    return { notice: { text: `${u.name}: language ${language ?? '(as written)'}.` }, back: 'people' };
  }
  if (action === 'invite') {
    const code = db.transaction(() => {
      const c = createInvite(db, u.id);
      ctx.audit('create_invite', u.id, {});
      return c;
    })();
    return { notice: { text: `Invite code for ${u.name} (shown once): ${code} — they send /start ${code} to the bot. It expires in 7 days.` }, back: 'people' };
  }
  return { notice: { text: 'Unknown action.', error: true }, back: 'people' };
}
