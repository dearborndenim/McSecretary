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
  /**
   * Optional — when piece-work-scanner exposes per-operation oldest age (newer
   * `?operation=<code>` support), we surface the op with the longest-standing
   * WIP. Falls back to the op with the highest piece count when absent.
   */
  oldest_operation?: string;
  pieces_by_operation_oldest_age?: Record<string, number>;
}

/**
 * Derive a one-line summary for the admin morning briefing — "⏳ Oldest WIP:
 * {op} piece — {age}h old". Returns null when data is unavailable so the
 * caller can skip the line entirely (fail-silent contract).
 *
 * The oldest operation is taken from:
 *   1. `oldest_operation` if the API surfaces it directly,
 *   2. `pieces_by_operation_oldest_age` max-by-value if present,
 *   3. the op with the highest count in `pieces_by_operation` as a last resort.
 */
export function formatOldestWipLine(summary: WipSummary | null): string | null {
  if (!summary) return null;
  if (summary.total_in_flight <= 0) return null;
  if (summary.oldest_wip_age_hours <= 0) return null;

  let op: string | undefined = summary.oldest_operation;

  if (!op && summary.pieces_by_operation_oldest_age) {
    const entries = Object.entries(summary.pieces_by_operation_oldest_age);
    if (entries.length > 0) {
      entries.sort((a, b) => b[1] - a[1]);
      op = entries[0]![0];
    }
  }

  if (!op) {
    const entries = Object.entries(summary.pieces_by_operation);
    if (entries.length === 0) return null;
    entries.sort((a, b) => b[1] - a[1]);
    op = entries[0]![0];
  }

  const age = summary.oldest_wip_age_hours.toFixed(1);
  return `⏳ Oldest WIP: ${op} piece — ${age}h old`;
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

    const result: WipSummary = {
      as_of: data.as_of,
      total_in_flight: data.total_in_flight,
      oldest_wip_age_hours: data.oldest_wip_age_hours,
      pieces_by_operation: data.pieces_by_operation as Record<string, number>,
    };
    if (typeof data.oldest_operation === 'string' && data.oldest_operation.length > 0) {
      result.oldest_operation = data.oldest_operation;
    }
    if (
      typeof data.pieces_by_operation_oldest_age === 'object' &&
      data.pieces_by_operation_oldest_age !== null
    ) {
      result.pieces_by_operation_oldest_age =
        data.pieces_by_operation_oldest_age as Record<string, number>;
    }
    return result;
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
