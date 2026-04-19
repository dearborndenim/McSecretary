/**
 * Work-in-Progress (WIP) summary for the admin morning briefing.
 *
 * Consumes piece-work-scanner's `/api/integration/wip-summary` endpoint:
 *   GET  /api/integration/wip-summary
 *   Auth: Authorization: Bearer <PIECE_WORK_SCANNER_API_KEY>
 *   Response:
 *     {
 *       "pieces_by_operation": { "cut": 120, "sew": 80, "hem": 35 },
 *       "oldest_wip_age_hours": 42.5,
 *       "total_in_flight": 235,
 *       "as_of": "2026-04-18T03:00:00Z"
 *     }
 *
 * Graceful-failure contract: any missing config, non-2xx, timeout, or
 * malformed JSON returns `null` so the caller (triage.ts) degrades the
 * briefing section to "WIP unavailable" rather than crashing. Timeout is
 * 5 seconds — tighter than the 10s used by inventory/uninvoiced because the
 * WIP fetch happens later in the briefing pipeline and we don't want to
 * delay delivery if piece-work-scanner is slow.
 */

export interface WipSummary {
  as_of: string;
  total_in_flight: number;
  oldest_wip_age_hours: number;
  pieces_by_operation: Record<string, number>;
}

const WIP_FETCH_TIMEOUT_MS = 5000;

/**
 * Fetch a WIP summary from piece-work-scanner. Returns null on any failure.
 */
export async function fetchWipSummary(
  baseUrl: string,
  apiKey: string,
): Promise<WipSummary | null> {
  if (!baseUrl || !apiKey) {
    return null;
  }

  try {
    const url = `${baseUrl.replace(/\/$/, '')}/api/integration/wip-summary`;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(WIP_FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      console.log(`WIP API returned ${response.status}: ${response.statusText}`);
      return null;
    }

    const data = (await response.json()) as Partial<WipSummary>;
    // Shape validation — without these fields the section would render
    // garbage, so fall back to unavailable rather than half-render.
    if (
      typeof data.total_in_flight !== 'number' ||
      typeof data.oldest_wip_age_hours !== 'number' ||
      typeof data.as_of !== 'string' ||
      typeof data.pieces_by_operation !== 'object' ||
      data.pieces_by_operation === null
    ) {
      console.log('WIP API returned malformed payload');
      return null;
    }

    return {
      as_of: data.as_of,
      total_in_flight: data.total_in_flight,
      oldest_wip_age_hours: data.oldest_wip_age_hours,
      pieces_by_operation: data.pieces_by_operation as Record<string, number>,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`Failed to fetch WIP summary: ${msg}`);
    return null;
  }
}

/**
 * Format the WIP summary into a text section for the briefing prompt.
 * Returns a consistent "unavailable" message when data is null so the
 * briefing still acknowledges the section.
 */
export function formatWipSection(summary: WipSummary | null): string {
  const lines: string[] = [];
  lines.push('WORK IN PROGRESS:');

  if (!summary) {
    lines.push('- WIP data unavailable (piece-work-scanner not reachable).');
    return lines.join('\n');
  }

  lines.push(`- As of: ${summary.as_of}`);
  lines.push(`- Total pieces in flight: ${summary.total_in_flight.toLocaleString()}`);
  lines.push(`- Oldest WIP age: ${summary.oldest_wip_age_hours.toFixed(1)} hours`);

  const operations = Object.entries(summary.pieces_by_operation);
  if (operations.length > 0) {
    lines.push('By operation:');
    // Sort descending by piece count so the biggest bottleneck surfaces first.
    const sorted = [...operations].sort((a, b) => b[1] - a[1]);
    for (const [op, count] of sorted) {
      lines.push(`- ${op}: ${count.toLocaleString()}`);
    }
  }

  return lines.join('\n');
}
