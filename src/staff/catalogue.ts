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
import { RENDERERS } from './render.js';

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
  /** read only: a renderer in src/staff/render.ts that turns the hand's JSON into plain text for the model. */
  render?: string;
  // write only
  action_type?: string;
  reversible?: boolean;
  cost_usd?: number | { param: string; unit_usd: number };
  level_required?: 1 | 2 | 3;
  expires_hours?: number;
  summary?: string;
  /** Trust level a user's ledger row starts at on their first filing (default 1; staff admin UI spec §4). */
  initial_level?: 1 | 2 | 3;
  /** OPERATOR direct actions (spec 2026-10-27): present = a Grok `grok_action` may run it. */
  operator?: OperatorSpec;
  /** write only: limits and checks McSecretary applies on the OPERATOR path (none = runs as asked). */
  limits?: ActionLimits;
}

/**
 * How an action differs on the OPERATOR path (`"operator": true` = not at all).
 * The Telegram staff path never reads this.
 * - params: extra params on this path; omit: Telegram params not taken here
 *   (an omitted switch param drops the switch, so `body` must replace it).
 * - locations: params that name a brand location (key or alias, `locations`
 *   in the brand file); each is replaced by that location's gid before the
 *   body is filled. An optional one defaults to the person's own location.
 * - body: write only, replaces the Telegram body.
 * - levels_by_location: read only; the answer's variants gain
 *   `levels_by_location` keyed by location key, for every registered location.
 * - path: read only, replaces the Telegram path on this path.
 * - answer: read only, how McSecretary shapes the hand's answer. `open_pos`:
 *   kanban's open-PO list (`GET /api/integration/pos?status=ordered`) filtered
 *   by the optional `po` / `q` params, each line with ordered/received/open
 *   (src/staff/po-lookup.ts).
 * - description: what the action does on this path, when it differs from the
 *   Telegram description (the OPERATOR contract text for that action).
 */
export interface OperatorSpec {
  params: Record<string, ParamSpec>;
  omit: string[];
  locations: string[];
  body?: Record<string, unknown>;
  levels_by_location?: boolean;
  path?: string;
  answer?: OperatorAnswer;
  description?: string;
}

export const OPERATOR_ANSWERS = ['open_pos'] as const;
export type OperatorAnswer = typeof OPERATOR_ANSWERS[number];

/**
 * On an OPERATOR write (spec 2026-10-27), one kind per action:
 * - per_sku: at most max_units of one SKU per request (the one hard limit: transfers).
 * - po_receipt: read the open PO from `read_path` on the action's hand first;
 *   any quantity runs, short and over lines are flagged to Robert.
 */
export interface ActionLimits {
  per_sku?: { max_units: number };
  po_receipt?: { read_path: string };
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
  'action_type', 'reversible', 'cost_usd', 'level_required', 'expires_hours', 'summary', 'initial_level', 'render',
  'operator', 'limits',
]);
const WRITE_ONLY_KEYS = ['body', 'action_type', 'reversible', 'cost_usd', 'level_required', 'expires_hours', 'summary', 'initial_level', 'limits'];
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

/**
 * Display-text forms of an array param (summary only): `{#name}` is the
 * number of entries, `{name.field}` the entries' values of one item field
 * joined with ", ".
 */
export const ARRAY_COUNT_RE = /^#([a-z][a-z0-9_]*)$/;
export const ARRAY_FIELD_RE = /^([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)$/;

function checkTemplates(where: string, strings: string[], names: Set<string>, arrays?: Record<string, ParamSpec>): void {
  for (const s of strings) {
    if (s.includes('{{') || s.includes('}}')) fail(where, 'double braces are reserved for the executor; bind proposal.id instead');
    for (const p of placeholders(s)) {
      if (names.has(p)) continue;
      const count = ARRAY_COUNT_RE.exec(p);
      const field = ARRAY_FIELD_RE.exec(p);
      if (arrays && count && arrays[count[1]!]) continue;
      if (arrays && field && arrays[field[1]!]?.items && Object.hasOwn(arrays[field[1]!]!.items!, field[2]!)) continue;
      fail(where, `{${p}} is not a declared param or binding`);
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
  const arrays = Object.fromEntries(Object.entries(params).filter(([, p]) => p.type === 'array'));

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
      checkTemplates(`${where} case ${value}`, stringsIn([sc.path, sc.body]), names);
      checkTemplates(`${where} case ${value}`, stringsIn([sc.summary]), names, arrays);
      if (!sc.path && action.path === undefined) fail(where, `switch case ${value} has no path and there is no base path`);
      cases[value] = sc;
    }
    action.switch = { param: sw.param, cases };
  } else if (action.path === undefined) {
    fail(where, 'path is required');
  }

  if (raw.render !== undefined) {
    if (kind !== 'read') fail(where, 'render is for reads only');
    if (typeof raw.render !== 'string' || !Object.hasOwn(RENDERERS, raw.render)) {
      fail(where, `render must be one of ${Object.keys(RENDERERS).join(', ')}`);
    }
    action.render = raw.render;
  }


  if (kind === 'read') {
    for (const k of WRITE_ONLY_KEYS) if (raw[k] !== undefined) fail(where, `${k} is for writes only`);
    checkTemplates(where, stringsIn([action.path]), names);
    if (raw.operator !== undefined && raw.operator !== false) action.operator = parseOperator(where, raw.operator, action, kind);
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
  if (raw.initial_level !== undefined) {
    if (raw.initial_level !== 1 && raw.initial_level !== 2 && raw.initial_level !== 3) fail(where, 'initial_level must be 1, 2 or 3');
    // Unreachable for a shipped catalogue (a pinned action_type is refused above); kept so the rule holds on its own.
    if (raw.initial_level > 1 && isPinned(action.action_type!)) fail(where, 'a pinned action_type cannot start above level 1');
    action.initial_level = raw.initial_level;
  }
  if (raw.limits !== undefined) action.limits = parseLimits(where, raw.limits, params);
  if (raw.operator !== undefined && raw.operator !== false) action.operator = parseOperator(where, raw.operator, action, kind);
  checkTemplates(where, stringsIn([action.path, action.body]), names);
  checkTemplates(where, stringsIn([action.summary]), names, arrays);
  return action;
}

const OPERATOR_KEYS = new Set(['params', 'omit', 'locations', 'body', 'levels_by_location', 'path', 'answer', 'description']);

function parseOperator(where: string, raw: unknown, action: StaffAction, kind: 'read' | 'write'): OperatorSpec {
  const spec: OperatorSpec = { params: {}, omit: [], locations: [] };
  if (raw === true) return spec;
  if (!isObj(raw)) fail(where, 'operator must be true or an object');
  for (const k of Object.keys(raw)) if (!OPERATOR_KEYS.has(k)) fail(where, `operator: unknown field ${k}`);
  if (raw.omit !== undefined) {
    if (!Array.isArray(raw.omit) || !raw.omit.every((n) => typeof n === 'string' && Object.hasOwn(action.params, n))) fail(where, 'operator.omit must name declared params');
    spec.omit = [...(raw.omit as string[])];
  }
  if (raw.params !== undefined) {
    if (!isObj(raw.params)) fail(where, 'operator.params must be an object');
    for (const [name, p] of Object.entries(raw.params)) {
      if (!NAME_RE.test(name)) fail(where, `operator param name ${name} is invalid`);
      if ((Object.hasOwn(action.params, name) && !spec.omit.includes(name)) || Object.hasOwn(action.bind, name)) fail(where, `operator param ${name} shadows a param or binding`);
      spec.params[name] = parseParam(`${where} operator param ${name}`, p, false);
    }
  }
  if (raw.locations !== undefined) {
    if (!Array.isArray(raw.locations) || !raw.locations.every((n) => typeof n === 'string' && spec.params[n]?.type === 'string')) {
      fail(where, 'operator.locations must name string operator params');
    }
    spec.locations = [...(raw.locations as string[])];
  }
  if (raw.levels_by_location !== undefined) {
    if (kind !== 'read' || typeof raw.levels_by_location !== 'boolean') fail(where, 'operator.levels_by_location is true/false on a read');
    spec.levels_by_location = raw.levels_by_location;
  }
  if (raw.body !== undefined) {
    if (kind !== 'write' || !isObj(raw.body)) fail(where, 'operator.body is an object on a write');
    spec.body = raw.body;
  }
  if (raw.path !== undefined) {
    if (kind !== 'read' || action.switch) fail(where, 'operator.path replaces the path of a read without a switch');
    spec.path = checkPath(`${where} operator`, raw.path, 'read');
  }
  if (raw.answer !== undefined) {
    if (kind !== 'read' || !(OPERATOR_ANSWERS as readonly unknown[]).includes(raw.answer)) fail(where, `operator.answer is one of ${OPERATOR_ANSWERS.join(', ')} on a read`);
    spec.answer = raw.answer as OperatorAnswer;
    if (spec.answer === 'open_pos') {
      for (const n of ['po', 'q']) if (spec.params[n]?.type !== 'string' || spec.params[n]!.required) fail(where, `operator.answer open_pos needs an optional string operator param ${n}`);
    }
  }
  if (raw.description !== undefined) {
    if (typeof raw.description !== 'string' || !raw.description.trim()) fail(where, 'operator.description must be text');
    spec.description = raw.description;
  }
  if (action.switch && spec.omit.includes(action.switch.param) && !spec.body) fail(where, 'operator omits the switch param, so it needs its own body');
  if (action.switch && spec.body && !spec.omit.includes(action.switch.param)) fail(where, 'operator.body replaces the switch body; omit the switch param too');
  const view = operatorView({ ...action, operator: spec });
  checkTemplates(`${where} operator`, stringsIn([view.path, view.body]), new Set([...Object.keys(view.params), ...Object.keys(action.bind)]));
  return spec;
}

/**
 * The action as the OPERATOR path runs it: operator params added, omitted
 * ones (and a switch on one) dropped, the operator body in place, and only the
 * bindings its path and body still use (so a recount at a named location does
 * not need the person's own location).
 */
export function operatorView(action: StaffAction): StaffAction {
  const op = action.operator;
  if (!op) return action;
  const params: Record<string, ParamSpec> = {};
  for (const [n, p] of Object.entries(action.params)) if (!op.omit.includes(n)) params[n] = p;
  Object.assign(params, op.params);
  const sw = action.switch && !op.omit.includes(action.switch.param) ? action.switch : undefined;
  const body = op.body ?? action.body;
  const path = op.path ?? action.path;
  const used = new Set(stringsIn([path, body, sw ? Object.values(sw.cases).map((c) => [c.path, c.body]) : []]).flatMap(placeholders));
  const bind = Object.fromEntries(Object.entries(action.bind).filter(([n]) => used.has(n)));
  return { ...action, params, bind, path, body, switch: sw, description: op.description ?? action.description };
}

function positive(where: string, v: unknown, name: string, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > max) fail(where, `limits ${name} must be a number above 0${max < Number.MAX_SAFE_INTEGER ? ` and at most ${max}` : ''}`);
  return v;
}

function needParam(where: string, params: Record<string, ParamSpec>, name: string, types: ParamType[], kind: string): ParamSpec {
  const p = params[name];
  if (!p || !types.includes(p.type) || !p.required) fail(where, `limits ${kind} needs a required ${types.join('/')} param ${name}`);
  return p;
}

function parseLimits(where: string, raw: unknown, params: Record<string, ParamSpec>): ActionLimits {
  if (!isObj(raw)) fail(where, 'limits must be an object');
  const kinds = Object.keys(raw);
  if (kinds.length !== 1) fail(where, 'limits must name exactly one of per_sku, po_receipt');
  const kind = kinds[0]!;
  const body = raw[kind];
  if (!isObj(body)) fail(where, `limits ${kind} must be an object`);
  const only = (keys: string[]) => { for (const k of Object.keys(body)) if (!keys.includes(k)) fail(where, `limits ${kind}: unknown field ${k}`); };
  switch (kind) {
    case 'per_sku':
      only(['max_units']);
      needParam(where, params, 'sku', ['string'], kind);
      needParam(where, params, 'quantity', ['integer', 'number'], kind);
      return { per_sku: { max_units: positive(where, body.max_units, 'per_sku.max_units') } };
    case 'po_receipt': {
      only(['read_path']);
      needParam(where, params, 'po_id', ['string'], kind);
      const lines = needParam(where, params, 'lines', ['array'], kind);
      if (!lines.items?.quantity?.required) fail(where, 'limits po_receipt needs lines items with a required quantity');
      const rp = checkPath(`${where} limits`, body.read_path, 'read');
      return { po_receipt: { read_path: rp } };
    }
    default:
      fail(where, `limits kind ${kind} is unknown; use per_sku or po_receipt`);
  }
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
