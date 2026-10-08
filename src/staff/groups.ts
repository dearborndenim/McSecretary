/**
 * Staff groups a user can be granted (staff access spec §5, §7.5).
 *
 * Build 1 only stores grants; nothing reads them yet. Build 2 replaces this
 * constant with the group names from the staff-action catalogue
 * (config/staff-actions.json) and keeps the export name.
 */
export const KNOWN_GROUPS: readonly string[] = ['store', 'receiving', 'floor-lead', 'office'];

/** The names in `groups` that are not known groups (empty = all valid). */
export function unknownGroups(groups: string[]): string[] {
  return groups.filter((g) => !KNOWN_GROUPS.includes(g));
}
