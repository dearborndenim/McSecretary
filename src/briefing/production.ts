/**
 * Production data fetcher — calls piece-work-scanner's production summary API
 * and formats the data for inclusion in McSecretary's morning briefing.
 */

export interface TopPerformer {
  name: string;
  pieces: number;
  goal_pct: number | null;
}

export interface YesterdayStats {
  total_pieces: number;
  employees_working: number;
  goal_hit_rate: number | null;
  top_performers: TopPerformer[];
}

export interface WeeklyTrend {
  this_week_avg: number;
  last_week_avg: number;
  change_pct: number;
}

export interface StreakEntry {
  name: string;
  type: string;
  days: number;
}

export interface ProductionSummary {
  date: string;
  yesterday: YesterdayStats;
  weekly_trend: WeeklyTrend;
  streaks: StreakEntry[];
}

/**
 * Fetch production summary from piece-work-scanner API.
 * Returns null if the API is unreachable or returns an error.
 */
export async function fetchProductionSummary(
  baseUrl: string,
  apiKey: string,
): Promise<ProductionSummary | null> {
  try {
    const url = `${baseUrl.replace(/\/$/, '')}/api/production/summary`;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'X-API-Key': apiKey,
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(10000), // 10 second timeout
    });

    if (!response.ok) {
      console.log(`Production API returned ${response.status}: ${response.statusText}`);
      return null;
    }

    const data = await response.json() as ProductionSummary;
    return data;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`Failed to fetch production summary: ${msg}`);
    return null;
  }
}

/**
 * Format production summary data into a text section for the briefing prompt.
 */
export function formatProductionSection(summary: ProductionSummary): string {
  const lines: string[] = [];
  lines.push('FACTORY PRODUCTION REPORT:');

  // Yesterday's stats
  const y = summary.yesterday;
  lines.push(`\nYesterday's Production:`);
  lines.push(`- Total pieces produced: ${y.total_pieces.toLocaleString()}`);
  lines.push(`- Employees working: ${y.employees_working}`);

  if (y.goal_hit_rate !== null) {
    lines.push(`- Goal hit rate: ${(y.goal_hit_rate * 100).toFixed(0)}%`);
  }

  if (y.top_performers.length > 0) {
    lines.push(`- Top performers:`);
    for (const p of y.top_performers.slice(0, 5)) {
      const goalStr = p.goal_pct !== null ? ` (${p.goal_pct}% of goal)` : '';
      lines.push(`  - ${p.name}: ${p.pieces} pieces${goalStr}`);
    }
  }

  // Weekly trend
  const t = summary.weekly_trend;
  lines.push(`\nWeekly Trend:`);
  lines.push(`- This week average: ${t.this_week_avg.toLocaleString()} pieces/day`);
  lines.push(`- Last week average: ${t.last_week_avg.toLocaleString()} pieces/day`);
  const direction = t.change_pct > 0 ? 'up' : t.change_pct < 0 ? 'down' : 'flat';
  lines.push(`- Change: ${direction} ${Math.abs(t.change_pct)}%`);

  // Streaks
  if (summary.streaks.length > 0) {
    lines.push(`\nNotable Streaks:`);
    for (const s of summary.streaks.slice(0, 5)) {
      lines.push(`- ${s.name}: ${s.days} consecutive production days`);
    }
  }

  return lines.join('\n');
}
