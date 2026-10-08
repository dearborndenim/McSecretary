/**
 * Staff-action catalogue → chat tool definitions for one user (spec §7.1).
 *
 * A member's staff tools are the actions in the union of their groups whose
 * user-row bindings they can satisfy (no location_id, no store tools). An
 * admin gets every action; one whose binding the admin cannot satisfy answers
 * with an explanation at call time instead.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { User } from '../db/user-queries.js';
import { getUserGrants } from '../db/user-queries.js';
import type { ParamSpec, StaffAction, StaffCatalogue } from './catalogue.js';

export type StaffUser = Pick<User, 'id' | 'name' | 'role' | 'brand_id' | 'grants_json' | 'location_id'>;

/** The user-row bindings this action needs that the user's row leaves empty. */
export function unsatisfiedBindings(action: StaffAction, user: StaffUser): string[] {
  const out: string[] = [];
  for (const [name, src] of Object.entries(action.bind)) {
    if (src === 'user.location_id' && !user.location_id) out.push(name);
  }
  return out;
}

/** The action ids in the union of the user's groups, in catalogue order (no binding filter). */
export function grantedActionIds(cat: StaffCatalogue, user: StaffUser): string[] {
  if (user.role === 'admin') return Object.keys(cat.actions);
  const granted = new Set<string>();
  for (const g of getUserGrants(user)) for (const id of cat.groups[g] ?? []) granted.add(id);
  return Object.keys(cat.actions).filter((id) => granted.has(id));
}

/** The actions this user may call: admin all; a member their grants with satisfiable bindings. */
export function staffActionIdsForUser(cat: StaffCatalogue, user: StaffUser): string[] {
  const ids = grantedActionIds(cat, user);
  if (user.role === 'admin') return ids;
  return ids.filter((id) => unsatisfiedBindings(cat.actions[id]!, user).length === 0);
}

function scalarSchema(spec: ParamSpec): Record<string, unknown> {
  const s: Record<string, unknown> = { description: spec.description };
  switch (spec.type) {
    case 'string': s.type = 'string'; s.maxLength = spec.max; break;
    case 'integer':
    case 'number':
      s.type = spec.type;
      if (spec.min !== undefined) s.minimum = spec.min;
      if (spec.max !== undefined) s.maximum = spec.max;
      break;
    case 'boolean': s.type = 'boolean'; break;
    case 'enum': s.type = 'string'; s.enum = spec.enum; break;
    default: break;
  }
  if (spec.default !== undefined) s.default = spec.default;
  return s;
}

function paramSchema(spec: ParamSpec): Record<string, unknown> {
  if (spec.type !== 'array') return scalarSchema(spec);
  const items = spec.items ?? {};
  return {
    type: 'array',
    description: spec.description,
    maxItems: spec.max,
    minItems: 1,
    items: {
      type: 'object',
      properties: Object.fromEntries(Object.entries(items).map(([k, v]) => [k, scalarSchema(v)])),
      required: Object.entries(items).filter(([, v]) => v.required).map(([k]) => k),
    },
  };
}

export function staffToolDefinition(action: StaffAction): Anthropic.Tool {
  return {
    name: action.id,
    description: action.description,
    input_schema: {
      type: 'object' as const,
      properties: Object.fromEntries(Object.entries(action.params).map(([k, v]) => [k, paramSchema(v)])),
      required: Object.entries(action.params).filter(([, v]) => v.required).map(([k]) => k),
    },
  };
}

export function staffToolsForUser(cat: StaffCatalogue, user: StaffUser): Anthropic.Tool[] {
  return staffActionIdsForUser(cat, user).map((id) => staffToolDefinition(cat.actions[id]!));
}

/** One line per action for /grant and /grants, naming any action held back by an empty binding. */
export function describeStaffTools(cat: StaffCatalogue, user: StaffUser): string {
  const usable = staffActionIdsForUser(cat, user);
  const held = grantedActionIds(cat, user).filter((id) => !usable.includes(id));
  const tools = usable.length > 0 ? usable.join(', ') : '(none)';
  return held.length > 0
    ? `tools: ${tools}; held back until /setlocation: ${held.join(', ')}`
    : `tools: ${tools}`;
}
