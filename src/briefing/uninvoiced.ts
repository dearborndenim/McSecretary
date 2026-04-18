/**
 * Uninvoiced PO dollar totals per brand for the admin morning briefing.
 *
 * Reuses the PO receiver's /api/integration/cost-summary endpoint, which
 * already exposes active_po_totals[].total_value — the uninvoiced/open-PO
 * dollar amount per customer brand.
 *
 * Any upstream failure returns null so the caller can render a
 * graceful-degradation message without crashing the briefing.
 */

export interface ActivePOTotal {
  brand: string;
  open_pos: number;
  total_units: number;
  total_value: number;
}

export interface CostSummary {
  generated_at: string;
  material_costs_by_brand: Array<Record<string, unknown>>;
  active_po_totals: ActivePOTotal[];
  pricing_margins: Array<Record<string, unknown>>;
  inventory_value: Array<Record<string, unknown>>;
}

/**
 * Fetch uninvoiced / open-PO totals from the PO receiver cost-summary feed.
 * Returns null on any failure.
 */
export async function fetchUninvoicedTotals(
  baseUrl: string,
  apiKey: string,
): Promise<ActivePOTotal[] | null> {
  if (!baseUrl || !apiKey) {
    return null;
  }
  try {
    const url = `${baseUrl.replace(/\/$/, '')}/api/integration/cost-summary`;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      console.log(`Cost-summary API returned ${response.status}: ${response.statusText}`);
      return null;
    }

    const data = (await response.json()) as CostSummary;
    if (!Array.isArray(data.active_po_totals)) {
      console.log('Cost-summary API returned no active_po_totals array');
      return null;
    }
    return data.active_po_totals;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`Failed to fetch uninvoiced totals: ${msg}`);
    return null;
  }
}

function formatUSD(amount: number): string {
  return amount.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  });
}

/**
 * Format the uninvoiced totals into a readable section. Returns a
 * user-facing "unavailable" message when data is null.
 */
export function formatUninvoicedSection(totals: ActivePOTotal[] | null): string {
  const lines: string[] = [];
  lines.push('UNINVOICED PO TOTALS (by brand):');

  if (!totals) {
    lines.push('- Uninvoiced PO data unavailable (PO receiver not reachable).');
    return lines.join('\n');
  }

  if (totals.length === 0) {
    lines.push('- No open purchase orders across any brand.');
    return lines.join('\n');
  }

  // Sort by total_value descending so the biggest outstanding dollars lead.
  const sorted = [...totals].sort((a, b) => b.total_value - a.total_value);
  const grandTotal = sorted.reduce((sum, t) => sum + t.total_value, 0);
  const totalOpenPos = sorted.reduce((sum, t) => sum + t.open_pos, 0);

  lines.push(`- Grand total: ${formatUSD(grandTotal)} across ${totalOpenPos} open PO${totalOpenPos === 1 ? '' : 's'}`);
  for (const t of sorted) {
    lines.push(`- ${t.brand}: ${formatUSD(t.total_value)} (${t.open_pos} open PO${t.open_pos === 1 ? '' : 's'}, ${t.total_units.toLocaleString()} units)`);
  }

  return lines.join('\n');
}
