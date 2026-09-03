/**
 * Human gates (spec §6). These action types are pinned at trust level 1 and
 * the ledger refuses to promote them. The list is the contract; agents name
 * their action types to match.
 */
export const PINNED_ACTION_TYPES: ReadonlyArray<string> = Object.freeze([
  // money
  'ad_spend_step_over_cap',
  'po_draft_over_threshold',
  'vendor_add',
  'hire_flag',
  // customer-facing
  'storefront_publish',
  'organic_post',
  'ad_launch',
  'price_change',
  // product
  'fabric_pick',
  'sample_approval',
  'techpack_signoff',
  'shopify_execute',
  // finance
  'policy_change',
]);

const PINNED = new Set(PINNED_ACTION_TYPES);

export function isPinned(actionType: string): boolean {
  return PINNED.has(actionType);
}
