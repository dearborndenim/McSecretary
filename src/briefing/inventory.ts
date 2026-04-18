/**
 * Inventory-on-hand summary for the admin morning briefing.
 *
 * Pulls the compact /api/integration/inventory-overview payload from the
 * purchase-order-receiver and formats top-level totals plus the top N
 * low-stock SKUs for inclusion in the briefing prompt.
 *
 * Any upstream failure (missing env var, network error, non-2xx, malformed
 * JSON) returns null so the caller can show "inventory data unavailable"
 * without crashing the briefing.
 */

export interface InventoryLowStockItem {
  brand: string;
  product_name: string;
  sku: string;
  current_quantity: number;
  reorder_point: number | null;
  status: 'LOW' | 'OUT';
}

export interface InventoryOverview {
  generated_at: string;
  total_units: number;
  total_skus: number;
  total_brands: number;
  low_stock_count: number;
  out_of_stock_count: number;
  low_stock: InventoryLowStockItem[];
}

/**
 * Fetch the compact inventory overview from the PO receiver.
 * Returns null on any failure. Caller is responsible for rendering a
 * graceful-degradation message.
 */
export async function fetchInventoryOverview(
  baseUrl: string,
  apiKey: string,
  limit: number = 5,
): Promise<InventoryOverview | null> {
  if (!baseUrl || !apiKey) {
    return null;
  }
  try {
    const url = `${baseUrl.replace(/\/$/, '')}/api/integration/inventory-overview?limit=${encodeURIComponent(String(limit))}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      console.log(`Inventory API returned ${response.status}: ${response.statusText}`);
      return null;
    }

    const data = (await response.json()) as InventoryOverview;
    return data;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`Failed to fetch inventory overview: ${msg}`);
    return null;
  }
}

/**
 * Format the inventory overview into a readable plain-text section for the
 * briefing prompt. Returns a user-facing "unavailable" message when data is
 * null so the briefing still acknowledges the section rather than silently
 * dropping it.
 */
export function formatInventorySection(overview: InventoryOverview | null): string {
  const lines: string[] = [];
  lines.push('INVENTORY ON HAND:');

  if (!overview) {
    lines.push('- Inventory data unavailable (PO receiver not reachable).');
    return lines.join('\n');
  }

  lines.push(`- Total units in pipeline: ${overview.total_units.toLocaleString()}`);
  lines.push(`- Total SKUs: ${overview.total_skus.toLocaleString()} across ${overview.total_brands} brand${overview.total_brands === 1 ? '' : 's'}`);
  lines.push(`- Low stock: ${overview.low_stock_count} | Out of stock: ${overview.out_of_stock_count}`);

  if (overview.low_stock.length > 0) {
    lines.push('');
    lines.push('Top low-stock SKUs:');
    for (const item of overview.low_stock) {
      const rp = item.reorder_point !== null ? ` (reorder at ${item.reorder_point})` : '';
      lines.push(`- [${item.status}] ${item.brand} ${item.product_name} — ${item.sku}: ${item.current_quantity}${rp}`);
    }
  }

  return lines.join('\n');
}
