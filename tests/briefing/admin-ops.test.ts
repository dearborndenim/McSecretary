import { describe, it, expect } from 'vitest';
import { buildBriefingPrompt } from '../../src/briefing/generator.js';
import { formatInventorySection } from '../../src/briefing/inventory.js';
import { formatUninvoicedSection } from '../../src/briefing/uninvoiced.js';
import { formatWipSection } from '../../src/briefing/wip.js';

const STATS = { totalProcessed: 5, archived: 3, flaggedForReview: 2 };

describe('buildBriefingPrompt adminOps gating', () => {
  it('includes inventory / uninvoiced / WIP sections when adminOps is supplied', () => {
    const prompt = buildBriefingPrompt([], STATS, undefined, undefined, undefined, undefined, undefined, {
      inventory: formatInventorySection({
        generated_at: 'x',
        total_units: 100,
        total_skus: 5,
        total_brands: 2,
        low_stock_count: 1,
        out_of_stock_count: 0,
        low_stock: [
          { brand: 'DDA', product_name: 'Jean', sku: 'J1', current_quantity: 2, reorder_point: 10, status: 'LOW' },
        ],
      }),
      uninvoiced: formatUninvoicedSection([
        { brand: 'AAC', open_pos: 1, total_units: 10, total_value: 500 },
      ]),
      wip: formatWipSection(null),
    });

    expect(prompt).toContain('INVENTORY ON HAND');
    expect(prompt).toContain('UNINVOICED PO TOTALS');
    expect(prompt).toContain('WORK IN PROGRESS');
    expect(prompt).toContain('DDA Jean');
    expect(prompt).toContain('AAC');
  });

  it('omits admin ops sections when adminOps is not supplied (member briefing)', () => {
    const prompt = buildBriefingPrompt([], STATS);
    expect(prompt).not.toContain('INVENTORY ON HAND');
    expect(prompt).not.toContain('UNINVOICED PO TOTALS');
    expect(prompt).not.toContain('WORK IN PROGRESS');
  });

  it('omits admin ops sections when adminOps is an empty object', () => {
    const prompt = buildBriefingPrompt([], STATS, undefined, undefined, undefined, undefined, undefined, {});
    expect(prompt).not.toContain('INVENTORY ON HAND');
    expect(prompt).not.toContain('UNINVOICED PO TOTALS');
    expect(prompt).not.toContain('WORK IN PROGRESS');
  });

  it('renders graceful-degradation messages when upstream data is unavailable', () => {
    const prompt = buildBriefingPrompt([], STATS, undefined, undefined, undefined, undefined, undefined, {
      inventory: formatInventorySection(null),
      uninvoiced: formatUninvoicedSection(null),
      wip: formatWipSection(null),
    });
    expect(prompt).toContain('Inventory data unavailable');
    expect(prompt).toContain('Uninvoiced PO data unavailable');
    expect(prompt).toContain('WIP data unavailable');
    // The prompt must still render without crashing and still contain email stats.
    expect(prompt).toContain('Total emails processed: 5');
  });

  it('partial adminOps (only inventory) still renders without the other two', () => {
    const prompt = buildBriefingPrompt([], STATS, undefined, undefined, undefined, undefined, undefined, {
      inventory: 'INVENTORY ON HAND:\n- Total units in pipeline: 50',
    });
    expect(prompt).toContain('INVENTORY ON HAND');
    expect(prompt).toContain('Total units in pipeline: 50');
    expect(prompt).not.toContain('UNINVOICED PO TOTALS');
    expect(prompt).not.toContain('WORK IN PROGRESS');
  });
});
