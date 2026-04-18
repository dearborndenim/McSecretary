import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  fetchInventoryOverview,
  formatInventorySection,
  type InventoryOverview,
} from '../../src/briefing/inventory.js';

const MOCK_OVERVIEW: InventoryOverview = {
  generated_at: '2026-04-17T05:00:00Z',
  total_units: 1234,
  total_skus: 42,
  total_brands: 4,
  low_stock_count: 3,
  out_of_stock_count: 2,
  low_stock: [
    { brand: 'DDA', product_name: 'Classic Jean', sku: 'CJ-32', current_quantity: 0, reorder_point: 20, status: 'OUT' },
    { brand: 'AAC', product_name: 'Straight Jean', sku: 'AA1-32', current_quantity: 0, reorder_point: 10, status: 'OUT' },
    { brand: 'DDA', product_name: 'Slim Jean', sku: 'SJ-32', current_quantity: 2, reorder_point: 20, status: 'LOW' },
    { brand: 'VFC', product_name: 'Red Flannel', sku: 'RF-L', current_quantity: 8, reorder_point: 15, status: 'LOW' },
    { brand: 'DDA', product_name: 'Relaxed Jean', sku: 'RJ-34', current_quantity: 14, reorder_point: 20, status: 'LOW' },
  ],
};

describe('formatInventorySection', () => {
  it('renders totals and breakdown when data is available', () => {
    const text = formatInventorySection(MOCK_OVERVIEW);
    expect(text).toContain('INVENTORY ON HAND');
    expect(text).toContain('1,234');
    expect(text).toContain('42');
    expect(text).toContain('4 brands');
    expect(text).toContain('Low stock: 3');
    expect(text).toContain('Out of stock: 2');
  });

  it('includes top low-stock SKUs with status tags', () => {
    const text = formatInventorySection(MOCK_OVERVIEW);
    expect(text).toContain('Top low-stock SKUs');
    expect(text).toContain('[OUT] DDA Classic Jean');
    expect(text).toContain('[LOW] DDA Slim Jean');
    expect(text).toContain('reorder at 20');
  });

  it('returns an unavailable message when data is null', () => {
    const text = formatInventorySection(null);
    expect(text).toContain('INVENTORY ON HAND');
    expect(text).toContain('unavailable');
  });

  it('does not render a low-stock block when there are no low items', () => {
    const text = formatInventorySection({
      ...MOCK_OVERVIEW,
      low_stock_count: 0,
      out_of_stock_count: 0,
      low_stock: [],
    });
    expect(text).not.toContain('Top low-stock SKUs');
  });

  it('pluralises "brand" correctly for a single brand', () => {
    const text = formatInventorySection({
      ...MOCK_OVERVIEW,
      total_brands: 1,
    });
    expect(text).toContain('1 brand');
    expect(text).not.toContain('1 brands');
  });
});

describe('fetchInventoryOverview', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns parsed data on successful response and uses Bearer auth', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(MOCK_OVERVIEW),
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await fetchInventoryOverview('https://receiver.example.com', 'test-key', 5);
    expect(result).toEqual(MOCK_OVERVIEW);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://receiver.example.com/api/integration/inventory-overview?limit=5',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer test-key' }),
      }),
    );
  });

  it('returns null when baseUrl is blank (missing config)', async () => {
    const result = await fetchInventoryOverview('', 'test-key');
    expect(result).toBeNull();
  });

  it('returns null on non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Server Error',
    }));
    const result = await fetchInventoryOverview('https://receiver.example.com', 'test-key');
    expect(result).toBeNull();
  });

  it('returns null on network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const result = await fetchInventoryOverview('https://receiver.example.com', 'test-key');
    expect(result).toBeNull();
  });

  it('strips trailing slash from base URL', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(MOCK_OVERVIEW) });
    vi.stubGlobal('fetch', mockFetch);

    await fetchInventoryOverview('https://receiver.example.com/', 'test-key');
    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toBe('https://receiver.example.com/api/integration/inventory-overview?limit=5');
  });
});
