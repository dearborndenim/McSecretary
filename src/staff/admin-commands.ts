/**
 * Admin commands that manage staff access (staff access spec §7.5):
 * `/grant`, `/grants`, `/setlocation` on Telegram and their CLI twins in
 * src/admin.ts. Pure over the DB and the brand config dir so both surfaces
 * share one implementation; the callers enforce admin-only.
 */

import type Database from 'better-sqlite3';
import {
  getAllUsers,
  getUserByEmail,
  getUserById,
  getUserGrants,
  setUserGrants,
  setUserLocation,
  setUserLanguage,
  LANGUAGE_TAG_RE,
  type User,
} from '../db/user-queries.js';
import { loadBrandConfig } from '../spine/brand-config.js';
import { knownGroups, unknownGroups } from './groups.js';
import { getCatalogue } from './catalogue.js';
import { describeStaffTools } from './tools.js';

const LOCATION_GID_RE = /^gid:\/\/shopify\/Location\/\d+$/;

type Result = { ok: true; message: string } | { ok: false; message: string };

function describeUser(u: User): string {
  const groups = getUserGrants(u);
  return `${u.name} <${u.email}> — groups: ${groups.length > 0 ? groups.join(', ') : '(none)'}; location: ${u.location_id ?? '(none)'}; language: ${u.language ?? '(as written)'}; ${describeStaffTools(getCatalogue(), u)}`;
}

/** Replaces the user's groups. Every group must be a catalogue group; nothing is written otherwise. */
export function grantGroups(db: Database.Database, email: string, groups: string[]): Result {
  const user = getUserByEmail(db, email.trim().toLowerCase());
  if (!user) return { ok: false, message: `No user found with email: ${email}` };
  if (groups.length === 0) return { ok: false, message: `Name at least one group. Known groups: ${knownGroups().join(', ')}` };
  const bad = unknownGroups(groups);
  if (bad.length > 0) {
    return { ok: false, message: `Unknown group(s): ${bad.join(', ')}. Known groups: ${knownGroups().join(', ')}` };
  }
  setUserGrants(db, user.id, groups);
  const updated = getUserById(db, user.id)!;
  return { ok: true, message: `Groups set. ${describeUser(updated)}` };
}

/** One user's groups, or every non-admin user's when `email` is omitted. */
export function describeGrants(db: Database.Database, email?: string): string {
  if (email && email.trim()) {
    const user = getUserByEmail(db, email.trim().toLowerCase());
    return user ? describeUser(user) : `No user found with email: ${email}`;
  }
  const members = getAllUsers(db).filter((u) => u.role !== 'admin');
  if (members.length === 0) return 'No members.';
  return members.map(describeUser).join('\n');
}

/**
 * A location argument to the gid it stands for: a Shopify location gid,
 * `store` (brand config store_location_id), `factory` (brand config
 * location_id), or `none` (null). Aliases resolve against `brandId`.
 */
export function resolveLocationArg(
  where: string, brandId: string, brandsDir: string,
): { ok: true; locationId: string | null } | { ok: false; message: string } {
  const arg = where.trim();
  const lower = arg.toLowerCase();
  if (lower === 'none') return { ok: true, locationId: null };
  if (lower === 'store' || lower === 'factory') {
    let brand;
    try {
      brand = loadBrandConfig(brandsDir, brandId);
    } catch (err) {
      return { ok: false, message: `Cannot load brand ${brandId}: ${err instanceof Error ? err.message : String(err)}` };
    }
    const field = lower === 'store' ? 'store_location_id' : 'location_id';
    const value = brand[field];
    if (!value) return { ok: false, message: `Brand ${brandId} has no ${field} set; pass the full location gid instead.` };
    return { ok: true, locationId: value };
  }
  if (LOCATION_GID_RE.test(arg)) return { ok: true, locationId: arg };
  return { ok: false, message: 'Location must be store, factory, none, or a gid like gid://shopify/Location/123.' };
}

/** Sets users.location_id from a location argument (see resolveLocationArg), against the user's own brand. */
export function setLocationByEmail(db: Database.Database, email: string, where: string, brandsDir: string): Result {
  const user = getUserByEmail(db, email.trim().toLowerCase());
  if (!user) return { ok: false, message: `No user found with email: ${email}` };
  const r = resolveLocationArg(where, user.brand_id, brandsDir);
  if (!r.ok) return r;
  setUserLocation(db, user.id, r.locationId);
  const updated = getUserById(db, user.id)!;
  return { ok: true, message: `Location set. ${describeUser(updated)}` };
}

/** Sets users.language to a BCP-47 tag, or clears it with `none` (reply in the language written in). */
export function setLanguageByEmail(db: Database.Database, email: string, tag: string): Result {
  const user = getUserByEmail(db, email.trim().toLowerCase());
  if (!user) return { ok: false, message: `No user found with email: ${email}` };
  const arg = tag.trim();
  let language: string | null;
  if (arg.toLowerCase() === 'none') {
    language = null;
  } else if (LANGUAGE_TAG_RE.test(arg)) {
    language = arg;
  } else {
    return { ok: false, message: 'Language must be a BCP-47 tag like es or pt-BR, or none.' };
  }
  setUserLanguage(db, user.id, language);
  const updated = getUserById(db, user.id)!;
  return { ok: true, message: `Language set. ${describeUser(updated)}` };
}

/**
 * Telegram entry point. Returns the reply for `/grant`, `/grants`,
 * `/setlocation` or `/setlanguage`, or null when `text` is none of them. Admin-only: the
 * caller checks the role before calling.
 */
export function handleStaffAdminCommand(db: Database.Database, text: string, brandsDir: string): string | null {
  const parts = text.trim().split(/\s+/);
  const cmd = parts[0]?.toLowerCase();
  if (cmd === '/grant') {
    if (parts.length < 3) return `Usage: /grant <email> <group> [group…]. Known groups: ${knownGroups().join(', ')}`;
    return grantGroups(db, parts[1]!, parts.slice(2).map((g) => g.toLowerCase())).message;
  }
  if (cmd === '/grants') {
    return describeGrants(db, parts[1]);
  }
  if (cmd === '/setlocation') {
    if (parts.length !== 3) return 'Usage: /setlocation <email> <location gid|store|factory|none>';
    return setLocationByEmail(db, parts[1]!, parts[2]!, brandsDir).message;
  }
  if (cmd === '/setlanguage') {
    if (parts.length !== 3) return 'Usage: /setlanguage <email> <bcp47 tag|none>';
    return setLanguageByEmail(db, parts[1]!, parts[2]!).message;
  }
  return null;
}
