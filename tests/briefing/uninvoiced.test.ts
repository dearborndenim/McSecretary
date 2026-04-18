import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  fetchUninvoicedTotals,
  formatUninvoicedSection,
  type ActivePOTotal,
} from '../../src/briefing/uninvoiced.js';

const MOCK_TOTALS: ActivePOTotal[] = [
  { brand: 'AAC', open_pos: 3, total_units: 500, total_value: 15000 },
  { brand: 'VFC', open_pos: 1, total_units: 100, total_value: 8000 },
  { brand: 'PHNX', open_pos: 2, total_units: 300, total_value: 25000 },
];

const MOCK_COST_SUMMARY = {
  generated_at: '2026-04-17T05:00:00Z',
  material_costs_by_brand: [],
  active_po_totals: MOCK_TOTALS,
  pricing_margins: [],
  inventory_value: [],
};

describe('formatUninvoicedSection', () => {
  it('sorts brands by total_value descending', () => {
    const text = formatUninvoicedSection(MOCK_TOTALS);
    const phnxIdx = text.indexOf('PHNX');
    const aacIdx = text.indexOf('AAC');
    const vfcIdx = text.indexOf('VFC');
    expect(phnxIdx).toBeGreaterThan(-1);
    expect(phnxIdx).toBeLessThan(aacIdx);
    expect(aacIdx).toBeLessThan(vfcIdx);
  });

  it('includes USD-formatted grand total and per-brand totals', () => {
    const text = formatUninvoicedSection(MOCK_TOTALS);
    expect(text).toContain('UNINVOICED PO TOTALS');
    expect(text).toContain('$48,000');
    expect(text).toContain('$25,000');
    expect(text).toContain('$15,000');
    expect(text).toContain('$8,000');
    expect(text).toContain('6 open POs');
  });

  it('returns an unavailable message when totals are null', () => {
    const text = formatUninvoicedSection(null);
    expect(text).toContain('UNINVOICED PO TOTALS');
    expect(text).toContain('unavailable');
  });

  it('handles empty totals list', () => {
    const text = formatUninvoicedSection([]);
    expect(text).toContain('No open purchase orders');
  });

  it('pluralises "PO" correctly for a single open PO', () => {
    const text = formatUninvoicedSection([
      { brand: 'VFC', open_pos: 1, total_units: 10, total_value: 500 },
    ]);
    expect(text).toContain('1 open PO');
    expect(text).not.toContain('1 open POs');
  });
});

describe('fetchUninvoicedTotals', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns active_po_totals on successful response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(MOCK_COST_SUMMARY),
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await fetchUninvoicedTotals('https://receiver.example.com', 'test-key');
    expect(result).toEqual(MOCK_TOTALS);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://receiver.example.com/api/integration/cost-summary',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer test-key' }),
      }),
    );
  });

  it('returns null when baseUrl is blank (missing config)', async () => {
    const result = await fetchUninvoicedTotals('', 'test-key');
    expect(result).toBeNull();
  });

  it('returns null on non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Unavailable',
    }));
    const result = await fetchUninvoicedTotals('https://receiver.example.com', 'test-key');
    expect(result).toBeNull();
  });

  it('returns null when response has no active_po_totals array', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ generated_at: 'x' }),
    }));
    const result = await fetchUninvoicedTotals('https://receiver.example.com', 'test-key');
    expect(result).toBeNull();
  });
});

describe('formatWipSection stub', () => {
  it('always returns an "unavailable" line today (endpoint stubbed)', async () => {
    const { formatWipSection, fetchWipSummary } = await import('../../src/briefing/wip.js');
    const result = await fetchWipSummary('https://scanner.example.com', 'test-key');
    expect(result).toBeNull();
    const text = formatWipSection(result);
    expect(text).toContain('WORK IN PROGRESS');
    expect(text).toContain('unavailable');
  });

  it('formats a real WIP summary when provided', async () => {
    const { formatWipSection } = await import('../../src/briefing/wip.js');
    const text = formatWipSection({
      as_of: '2026-04-17',
      total_units_in_progress: 1500,
      stages: [
        { stage: 'CUT', units: 500 },
        { stage: 'SEWN', units: 700 },
      ],
    });
    expect(text).toContain('1,500');
    expect(text).toContain('CUT: 500');
    expect(text).toContain('SEWN: 700');
  });
});
