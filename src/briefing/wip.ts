/**
 * Work-in-Progress (WIP) summary for the admin morning briefing.
 *
 * Piece-work-scanner currently exposes a /integration/production-summary
 * endpoint (already wired through briefing/production.ts) but does NOT yet
 * expose a dedicated WIP endpoint — i.e. open work that has been cut/sewn
 * but not yet shipped, rolled up by operation/style.
 *
 * TODO: once piece-work-scanner ships an /integration/wip-summary endpoint
 * (see piece-work-scanner PROJECT_STATUS.md, "WIP rollup by stage"), swap
 * the stub below for a real fetch that mirrors the production.ts client
 * (Bearer token, 10s timeout, graceful-failure contract).
 *
 * Until then, this module returns a consistent "WIP data unavailable" line
 * so admin briefings always acknowledge the section rather than silently
 * dropping it.
 */

export interface WipSummary {
  as_of: string;
  total_units_in_progress: number;
  stages: Array<{ stage: string; units: number }>;
}

/**
 * Fetch a WIP summary from the piece-work-scanner. Currently a stub — the
 * upstream endpoint does not yet exist, so we always return null.
 *
 * Keeping the function signature ready for the eventual implementation means
 * triage.ts does not need to change when the endpoint lands.
 */
export async function fetchWipSummary(
  baseUrl: string,
  apiKey: string,
): Promise<WipSummary | null> {
  // Intentionally unused — stubbed until the upstream endpoint ships.
  void baseUrl;
  void apiKey;
  return null;
}

/**
 * Format the WIP summary into a text section for the briefing prompt.
 * Returns a consistent unavailable message while the upstream endpoint is
 * pending.
 */
export function formatWipSection(summary: WipSummary | null): string {
  const lines: string[] = [];
  lines.push('WORK IN PROGRESS:');
  if (!summary) {
    lines.push('- WIP data unavailable (piece-work-scanner does not yet expose a WIP endpoint).');
    return lines.join('\n');
  }

  lines.push(`- As of: ${summary.as_of}`);
  lines.push(`- Total units in progress: ${summary.total_units_in_progress.toLocaleString()}`);
  if (summary.stages.length > 0) {
    lines.push('By stage:');
    for (const s of summary.stages) {
      lines.push(`- ${s.stage}: ${s.units.toLocaleString()}`);
    }
  }
  return lines.join('\n');
}
