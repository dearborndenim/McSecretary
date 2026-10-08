/**
 * The staff-action catalogue (staff access spec §5): config/staff-actions.json,
 * loaded and validated at boot. A malformed entry throws, so McSecretary does
 * not start with a catalogue that could build a hand call nobody reviewed.
 *
 * The chat model only ever picks an action id and fills its typed params; the
 * hand, method, path and body come from here (spec §2 principle 2).
 */

import fs from 'node:fs';
import { isPinned } from '../spine/gates.js';
import type { BrandConfig } from '../spine/brand-config.js';
import { isPlainObject as isObj } from '../spine/json-object.js';

export type ParamType = 'string' | 'integer' | 'number' | 'boolean' | 'enum' | 'array';

export interface ParamSpec {
  type: ParamType;
  required: boolean;
  description: string;
  enum?: string[];
  /** integer/number: lower bound. */
  min?: number;
  /** integer/number: upper bound; string: max length (default 200); array: max items. */
  max?: number;
  /** An optional param's value when the model leaves it out. */
  default?: string | number | boolean;
  /** array only: the fields of each item (scalar types only). */
  items?: Record<string, ParamSpec>;
  /** array only: each item must carry at least one of these fields. */
  items_require_one_of?: string[];
}

export const BIND_SOURCES = [
  'user.location_id', 'user.brand_id', 'user.id', 'user.name', 'brand.location_id', 'proposal.id',
] as const;
export type BindSource = (typeof BIND_SOURCES)[number];

/** A per-value override of path / body / summary, chosen by one enum param. */
export interface SwitchCase {
  path?: string;
  body?: Record<string, unknown>;
  summary?: string;
}

export interface StaffAction {
  id: string;
  kind: 'read' | 'write';
  description: string;
  params: Record<string, ParamSpec>;
  bind: Record<string, BindSource>;
  hand: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH';
  path?: string;
  body?: Record<string, unknown>;
  switch?: { param: string; cases: Record<string, SwitchCase> };
  // write only
  action_type?: string;
  reversible?: boolean;
  cost_usd?: number | { param: string; unit_usd: number };
  level_required?: 1 | 2 | 3;
  expires_hours?: number;
  summary?: string;
}

export interface StaffCatalogue {
  groups: Record<string, string[]>;
  actions: Record<string, StaffAction>;
}

/** Built-in hands the executor answers itself; no brand config entry needed. */
export const BUILT_IN_HANDS: ReadonlySet<string> = new Set(['notes']);

export const READ_PATH_PREFIX = '/api/integration/';
export const DEFAULT_STRING_MAX = 200;

/** Evidence keys the execute step writes itself; a param may not shadow them. */
const RESERVED_PARAM_NAMES = new Set(['requested_by', 'request_text']);

const ACTION_ID_RE = /^[a-z][a-z0-9_]{0,63}$/;
const GROUP_RE = /^[a-z][a-z0-9-]{0,31}$/;
const NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
/** `{name}` placeholders. `{{proposal.id}}` is the executor's, never the catalogue's. */
export const PLACEHOLDER_RE = /\{([^{}]*)\}/g;

const ACTION_KEYS = new Set([
  'kind', 'description', 'params', 'bind', 'hand', 'method', 'path', 'body', 'switch',
  'action_type', 'reversible', 'cost_usd', 'level_required', 'expires_hours', 'summary',
]);
const WRITE_ONLY_KEYS = ['body', 'action_type', 'reversible', 'cost_usd', 'level_required', 'expires_hours', 'summary'];
const PARAM_KEYS = new Set(['type', 'required', 'description', 'enum', 'min', 'max', 'default', 'items', 'items_require_one_of']);
const TYPES = new Set<ParamType>(['string', 'integer', 'number', 'boolean', 'enum', 'array']);

class CatalogueError extends Error {}

function fail(where: string, msg: string): never {
  throw new CatalogueError(`staff-actions: ${where}: ${msg}`);
}

function parseParam(where: string, raw: unknown, allowArray: boolean): ParamSpec {
  if (!isObj(raw)) fail(where, 'must be an object');
  for (const k of Object.keys(raw)) if (!PARAM_KEYS.has(k)) fail(where, `unknown field ${k}`);
  const type = raw.type as ParamType;
  if (!TYPES.has(type)) fail(where, `type must be one of ${[...TYPES].join(', ')}`);
  if (type === 'array' && !allowArray) fail(where, 'an array item field cannot itself be an array');
  if (raw.required !== undefined && typeof raw.required !== 'boolean') fail(where, 'required must be true or false');
  if (typeof raw.description !== 'string' || !raw.description.trim()) fail(where, 'description is required');
  const spec: ParamSpec = { type, required: raw.required === true, description: raw.description };
  for (const k of ['min', 'max'] as const) {
    if (raw[k] === undefined) continue;
    if (typeof raw[k] !== 'number' || !Number.isFinite(raw[k])) fail(where, `${k} must be a number`);
    spec[k] = raw[k] as number;
  }
  if ((type === 'boolean' || type === 'enum') && (spec.min !== undefined || spec.max !== undefined)) {
    fail(where, `${type} takes no min/max`);
  }
  if (type === 'enum') {
    const e = raw.enum;
    if (!Array.isArray(e) || e.length === 0 || !e.every((x) => typeof x === 'string' && x.length > 0)) {
      fail(where, 'enum must be a non-empty list of strings');
    }
    if (new Set(e).size !== e.length) fail(where, 'enum has duplicates');
    spec.enum = e as string[];
  } else if (raw.enum !== undefined) {
    fail(where, 'enum is only for type enum');
  }
  if (type === 'string') {
    spec.max = spec.max ?? DEFAULT_STRING_MAX;
    if (spec.min !== undefined) fail(where, 'string takes max (length) only');
    if (!Number.isInteger(spec.max) || spec.max < 1) fail(where, 'string max must be a positive integer');
  }
  if (type === 'integer' || type === 'number') {
    if (spec.min !== undefined && spec.max !== undefined && spec.min > spec.max) fail(where, 'min is above max');
  }
  if (type === 'array') {
    if (spec.max === undefined || !Number.isInteger(spec.max) || spec.max < 1) fail(where, 'array needs max (items), a positive integer');
    if (spec.min !== undefined) fail(where, 'array takes max only');
    if (!isObj(raw.items) || Object.keys(raw.items).length === 0) fail(where, 'array needs items');
    const items: Record<string, ParamSpec> = {};
    for (const [name, f] of Object.entries(raw.items)) {
      if (!NAME_RE.test(name)) fail(where, `item field name ${name} is invalid`);
      items[name] = parseParam(`${where}.items.${name}`, f, false);
    }
    spec.items = items;
    if (raw.items_require_one_of !== undefined) {
      const one = raw.items_require_one_of;
      if (!Array.isArray(one) || one.length === 0 || !one.every((x) => typeof x === 'string' && Object.hasOwn(items, x))) {
        fail(where, 'items_require_one_of must name item fields');
      }
      spec.items_require_one_of = one as string[];
    }
  } else if (raw.items !== undefined || raw.items_require_one_of !== undefined) {
    fail(where, 'items is only for type array');
  }
  if (raw.default !== undefined) {
    if (spec.required) fail(where, 'a required param takes no default');
    const d = raw.default;
    if (typeof d !== 'string' && typeof d !== 'number' && typeof d !== 'boolean') fail(where, 'default must be a scalar');
    const err = checkValue(spec, d);
    if (err) fail(where, `default: ${err}`);
    spec.default = d;
  }
  return spec;
}

/** One scalar value against its spec; null when valid. Arrays are checked by validateParams. */
export function checkValue(spec: ParamSpec, v: unknown): string | null {
  switch (spec.type) {
    case 'string':
      if (typeof v !== 'string') return 'must be text';
      if (v.length > (spec.max ?? DEFAULT_STRING_MAX)) return `must be at most ${spec.max ?? DEFAULT_STRING_MAX} characters`;
      return null;
    case 'integer':
    case 'number':
      if (typeof v !== 'number' || !Number.isFinite(v)) return 'must be a number';
      if (spec.type === 'integer' && !Number.isInteger(v)) return 'must be a whole number';
      if (spec.min !== undefined && v < spec.min) return `must be at least ${spec.min}`;
      if (spec.max !== undefined && v > spec.max) return `must be at most ${spec.max}`;
      return null;
    case 'boolean':
      return typeof v === 'boolean' ? null : 'must be true or false';
    case 'enum':
      return typeof v === 'string' && spec.enum!.includes(v) ? null : `must be one of ${spec.enum!.join(', ')}`;
    default:
      return 'is not a scalar';
  }
}

/** Every `{name}` in a string. */
export function placeholders(s: string): string[] {
  return [...s.matchAll(PLACEHOLDER_RE)].map((m) => m[1]!);
}

function stringsIn(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => stringsIn(x, out));
  else if (isObj(v)) Object.values(v).forEach((x) => stringsIn(x, out));
  return out;
}

function checkTemplates(where: string, strings: string[], names: Set<string>): void {
  for (const s of strings) {
    if (s.includes('{{') || s.includes('}}')) fail(where, 'double braces are reserved for the executor; bind proposal.id instead');
    for (const p of placeholders(s)) {
      if (!names.has(p)) fail(where, `{${p}} is not a declared param or binding`);
    }
  }
}

function checkPath(where: string, path: unknown, kind: 'read' | 'write'): string {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) fail(where, 'path must start with a single /');
  if (kind === 'read' && !path.startsWith(READ_PATH_PREFIX)) fail(where, `a read path must start with ${READ_PATH_PREFIX}`);
  if (path.includes('#')) fail(where, 'path may not carry a fragment');
  const [p, q] = path.split('?', 2) as [string, string | undefined];
  if (p.split('/').some((seg) => seg === '.' || seg === '..')) fail(where, 'path has relative segments');
  if (q !== undefined && kind === 'write') fail(where, 'a write path may not carry a query');
  return path;
}

function parseAction(id: string, raw: unknown): StaffAction {
  const where = `action ${id}`;
  if (!ACTION_ID_RE.test(id)) fail(where, 'id must be lowercase letters, digits and _');
  if (!isObj(raw)) fail(where, 'must be an object');
  for (const k of Object.keys(raw)) if (!ACTION_KEYS.has(k)) fail(where, `unknown field ${k}`);
  const kind = raw.kind;
  if (kind !== 'read' && kind !== 'write') fail(where, 'kind must be read or write');
  if (typeof raw.description !== 'string' || !raw.description.trim()) fail(where, 'description is required');
  if (typeof raw.hand !== 'string' || !raw.hand.trim()) fail(where, 'hand is required');

  const method = raw.method;
  if (!['GET', 'POST', 'PUT', 'PATCH'].includes(method as string)) fail(where, 'method must be GET, POST, PUT or PATCH');
  if (kind === 'read' && method !== 'GET') fail(where, 'a read must use GET');
  if (kind === 'write' && method === 'GET') fail(where, 'a write may not use GET');

  const params: Record<string, ParamSpec> = {};
  if (raw.params !== undefined) {
    if (!isObj(raw.params)) fail(where, 'params must be an object');
    for (const [name, spec] of Object.entries(raw.params)) {
      if (!NAME_RE.test(name)) fail(where, `param name ${name} is invalid`);
      if (RESERVED_PARAM_NAMES.has(name)) fail(where, `param name ${name} is reserved`);
      params[name] = parseParam(`${where} param ${name}`, spec, true);
    }
  }

  const bind: Record<string, BindSource> = {};
  if (raw.bind !== undefined) {
    if (!isObj(raw.bind)) fail(where, 'bind must be an object');
    for (const [name, src] of Object.entries(raw.bind)) {
      if (!NAME_RE.test(name)) fail(where, `binding name ${name} is invalid`);
      if (Object.hasOwn(params, name)) fail(where, `binding ${name} shadows a param; a bound value never comes from input`);
      if (!(BIND_SOURCES as readonly unknown[]).includes(src)) fail(where, `binding ${name}: source must be one of ${BIND_SOURCES.join(', ')}`);
      if (src === 'proposal.id' && kind === 'read') fail(where, 'a read has no proposal to bind');
      bind[name] = src as BindSource;
    }
  }
  const names = new Set([...Object.keys(params), ...Object.keys(bind)]);

  const action: StaffAction = {
    id, kind, description: raw.description, params, bind, hand: raw.hand, method: method as StaffAction['method'],
  };

  if (raw.path !== undefined) action.path = checkPath(where, raw.path, kind);
  if (raw.switch !== undefined) {
    const sw = raw.switch;
    if (!isObj(sw) || typeof sw.param !== 'string' || !isObj(sw.cases)) fail(where, 'switch must be {param, cases}');
    const spec = params[sw.param];
    if (!spec || spec.type !== 'enum') fail(where, `switch param ${String(sw.param)} must be a declared enum param`);
    if (!spec.required && spec.default === undefined) fail(where, 'switch param must be required or have a default');
    const caseKeys = Object.keys(sw.cases).sort();
    if (JSON.stringify(caseKeys) !== JSON.stringify([...spec.enum!].sort())) fail(where, 'switch cases must match the enum values exactly');
    const cases: Record<string, SwitchCase> = {};
    for (const [value, c] of Object.entries(sw.cases)) {
      if (!isObj(c)) fail(where, `switch case ${value} must be an object`);
      for (const k of Object.keys(c)) if (!['path', 'body', 'summary'].includes(k)) fail(where, `switch case ${value}: unknown field ${k}`);
      const sc: SwitchCase = {};
      if (c.path !== undefined) sc.path = checkPath(`${where} case ${value}`, c.path, kind);
      if (c.body !== undefined) {
        if (kind === 'read') fail(where, 'a read takes no body');
        if (!isObj(c.body)) fail(where, `switch case ${value}: body must be an object`);
        sc.body = c.body;
      }
      if (c.summary !== undefined) {
        if (kind === 'read' || typeof c.summary !== 'string') fail(where, `switch case ${value}: summary must be text on a write`);
        sc.summary = c.summary;
      }
      checkTemplates(`${where} case ${value}`, stringsIn([sc.path, sc.body, sc.summary]), names);
      if (!sc.path && action.path === undefined) fail(where, `switch case ${value} has no path and there is no base path`);
      cases[value] = sc;
    }
    action.switch = { param: sw.param, cases };
  } else if (action.path === undefined) {
    fail(where, 'path is required');
  }

  if (kind === 'read') {
    for (const k of WRITE_ONLY_KEYS) if (raw[k] !== undefined) fail(where, `${k} is for writes only`);
    checkTemplates(where, stringsIn([action.path]), names);
    return action;
  }

  if (raw.body !== undefined && !isObj(raw.body)) fail(where, 'body must be an object');
  action.body = (raw.body as Record<string, unknown> | undefined) ?? {};
  if (typeof raw.action_type !== 'string' || !NAME_RE.test(raw.action_type)) fail(where, 'action_type is required (lowercase, _)');
  if (isPinned(raw.action_type)) fail(where, `action_type ${raw.action_type} is a pinned human gate; staff never file it`);
  action.action_type = raw.action_type;
  if (typeof raw.reversible !== 'boolean') fail(where, 'reversible must be true or false');
  action.reversible = raw.reversible;
  const cost = raw.cost_usd;
  if (typeof cost === 'number') {
    if (!Number.isFinite(cost) || cost < 0) fail(where, 'cost_usd must be 0 or more');
  } else if (isObj(cost)) {
    const p = params[cost.param as string];
    if (!p || (p.type !== 'integer' && p.type !== 'number') || !p.required) fail(where, 'cost_usd.param must be a required numeric param');
    if (typeof cost.unit_usd !== 'number' || !Number.isFinite(cost.unit_usd) || cost.unit_usd < 0) fail(where, 'cost_usd.unit_usd must be 0 or more');
  } else {
    fail(where, 'cost_usd must be a number or {param, unit_usd}');
  }
  action.cost_usd = cost as StaffAction['cost_usd'];
  if (raw.level_required !== 1 && raw.level_required !== 2 && raw.level_required !== 3) fail(where, 'level_required must be 1, 2 or 3');
  action.level_required = raw.level_required;
  if (typeof raw.expires_hours !== 'number' || !(raw.expires_hours > 0) || raw.expires_hours > 24 * 14) fail(where, 'expires_hours must be above 0 and at most 336');
  action.expires_hours = raw.expires_hours;
  if (typeof raw.summary !== 'string' || !raw.summary.trim()) fail(where, 'summary is required on a write');
  action.summary = raw.summary;
  checkTemplates(where, stringsIn([action.path, action.body, action.summary]), names);
  return action;
}

/** Validate a parsed catalogue file. Throws naming the first problem. */
export function parseCatalogue(raw: unknown): StaffCatalogue {
  if (!isObj(raw)) fail('file', 'must be a JSON object');
  for (const k of Object.keys(raw)) {
    if (k !== 'groups' && k !== 'actions' && k !== '_comment') fail('file', `unknown top-level field ${k}`);
  }
  if (!isObj(raw.actions) || Object.keys(raw.actions).length === 0) fail('file', 'actions must be a non-empty object');
  if (!isObj(raw.groups) || Object.keys(raw.groups).length === 0) fail('file', 'groups must be a non-empty object');
  const actions: Record<string, StaffAction> = {};
  for (const [id, a] of Object.entries(raw.actions)) actions[id] = parseAction(id, a);
  const groups: Record<string, string[]> = {};
  for (const [name, list] of Object.entries(raw.groups)) {
    if (!GROUP_RE.test(name)) fail(`group ${name}`, 'name must be lowercase letters, digits and -');
    if (!Array.isArray(list) || list.length === 0) fail(`group ${name}`, 'must be a non-empty list of action ids');
    for (const id of list) {
      if (typeof id !== 'string' || !Object.hasOwn(actions, id)) fail(`group ${name}`, `unknown action ${String(id)}`);
    }
    groups[name] = [...new Set(list as string[])];
  }
  return { groups, actions };
}

export function loadCatalogue(file: string): StaffCatalogue {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`staff-actions: cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseCatalogue(raw);
}

export function catalogueFileFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return env.STAFF_ACTIONS_PATH ?? 'config/staff-actions.json';
}

let current: StaffCatalogue | null = null;

/** The process catalogue, loaded on first use (boot calls it first, so a bad file stops the boot). */
export function getCatalogue(): StaffCatalogue {
  current ??= loadCatalogue(catalogueFileFromEnv());
  return current;
}

/** Tests and boot only. */
export function setCatalogue(c: StaffCatalogue | null): void {
  current = c;
}

/**
 * Boot checks (spec §7.6) against the legacy brand: every hand a group uses
 * must be in that brand file (or built in), and no action id may shadow a chat
 * tool name — both throw. A hand whose env vars are absent only warns, so
 * McSecretary still boots before that hand is deployed. Returns the warnings.
 */
export function checkCatalogueAgainstBrand(
  cat: StaffCatalogue,
  brand: BrandConfig,
  env: Record<string, string | undefined>,
  chatToolNames: Iterable<string>,
): string[] {
  const tools = new Set(chatToolNames);
  for (const id of Object.keys(cat.actions)) {
    if (tools.has(id)) throw new Error(`staff-actions: action ${id} has the same name as a chat tool`);
  }
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const ids of Object.values(cat.groups)) {
    for (const id of ids) {
      const hand = cat.actions[id]!.hand;
      if (seen.has(hand)) continue;
      seen.add(hand);
      const ref = Object.hasOwn(brand.hands, hand) ? brand.hands[hand] : undefined;
      if (!ref) {
        if (BUILT_IN_HANDS.has(hand)) continue;
        throw new Error(`staff-actions: hand ${hand} (action ${id}) is not in brand ${brand.brand_id}`);
      }
      const missing = [ref.url_env, ref.key_env].filter((k) => !env[k]);
      if (missing.length > 0) {
        warnings.push(`staff-actions: hand ${hand} has no ${missing.join('/')} set; its staff actions answer "not connected" until it is`);
      }
    }
  }
  return warnings;
}
