import { describe, it, expect } from 'vitest';
import { PINNED_ACTION_TYPES, isPinned } from '../../src/spine/gates.js';

describe('gates', () => {
  it('pins every action type from spec §6', () => {
    for (const t of [
      'ad_spend_step_over_cap', 'po_draft_over_threshold', 'vendor_add', 'hire_flag',
      'storefront_publish', 'organic_post', 'ad_launch', 'price_change',
      'fabric_pick', 'sample_approval', 'techpack_signoff', 'shopify_execute',
      'policy_change',
    ]) {
      expect(isPinned(t), t).toBe(true);
    }
  });

  it('does not pin routine actions', () => {
    expect(isPinned('creative_request')).toBe(false);
    expect(isPinned('noop')).toBe(false);
  });

  it('exports the list frozen', () => {
    expect(Object.isFrozen(PINNED_ACTION_TYPES)).toBe(true);
  });
});
