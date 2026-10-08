/**
 * Staff groups a user can be granted (staff access spec §5, §7.5): the group
 * names in the staff-action catalogue (config/staff-actions.json).
 */

import { getCatalogue } from './catalogue.js';

export function knownGroups(): string[] {
  return Object.keys(getCatalogue().groups);
}

/** The names in `groups` that are not known groups (empty = all valid). */
export function unknownGroups(groups: string[]): string[] {
  const known = new Set(knownGroups());
  return groups.filter((g) => !known.has(g));
}
