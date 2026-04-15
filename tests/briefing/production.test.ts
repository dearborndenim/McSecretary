import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  fetchProductionSummary,
  formatProductionSection,
  type ProductionSummary,
} from '../../src/briefing/production.js';

const MOCK_SUMMARY: ProductionSummary = {
  date: '2026-04-14',
  yesterday: {
    total_pieces: 1234,
    employees_working: 12,
    goal_hit_rate: 0.75,
    top_performers: [
      { name: 'Maria', pieces: 200, goal_pct: 120.0 },
      { name: 'Carlos', pieces: 180, goal_pct: 108.0 },
      { name: 'Ana', pieces: 160, goal_pct: 96.0 },
    ],
  },
  weekly_trend: {
    this_week_avg: 1100,
    last_week_avg: 1050,
    change_pct: 4.8,
  },
  streaks: [
    { name: 'Maria', type: 'consecutive_production', days: 8 },
    { name: 'Carlos', type: 'consecutive_production', days: 5 },
  ],
};

describe('formatProductionSection', () => {
  it('formats yesterday stats correctly', () => {
    const result = formatProductionSection(MOCK_SUMMARY);
    expect(result).toContain('FACTORY PRODUCTION REPORT');
    expect(result).toContain('1,234');
    expect(result).toContain('12');
    expect(result).toContain('75%');
  });

  it('includes top performers', () => {
    const result = formatProductionSection(MOCK_SUMMARY);
    expect(result).toContain('Maria');
    expect(result).toContain('200 pieces');
    expect(result).toContain('120%');
    expect(result).toContain('Carlos');
  });

  it('includes weekly trend', () => {
    const result = formatProductionSection(MOCK_SUMMARY);
    expect(result).toContain('This week average');
    expect(result).toContain('Last week average');
    expect(result).toContain('up 4.8%');
  });

  it('includes streaks', () => {
    const result = formatProductionSection(MOCK_SUMMARY);
    expect(result).toContain('Notable Streaks');
    expect(result).toContain('Maria: 8 consecutive production days');
    expect(result).toContain('Carlos: 5 consecutive production days');
  });

  it('handles no streaks gracefully', () => {
    const noStreaks = { ...MOCK_SUMMARY, streaks: [] };
    const result = formatProductionSection(noStreaks);
    expect(result).not.toContain('Notable Streaks');
  });

  it('handles null goal_hit_rate', () => {
    const noGoal = {
      ...MOCK_SUMMARY,
      yesterday: { ...MOCK_SUMMARY.yesterday, goal_hit_rate: null },
    };
    const result = formatProductionSection(noGoal);
    expect(result).not.toContain('Goal hit rate');
  });

  it('handles negative trend (down)', () => {
    const downTrend = {
      ...MOCK_SUMMARY,
      weekly_trend: { this_week_avg: 900, last_week_avg: 1050, change_pct: -14.3 },
    };
    const result = formatProductionSection(downTrend);
    expect(result).toContain('down 14.3%');
  });

  it('handles flat trend', () => {
    const flat = {
      ...MOCK_SUMMARY,
      weekly_trend: { this_week_avg: 1000, last_week_avg: 1000, change_pct: 0 },
    };
    const result = formatProductionSection(flat);
    expect(result).toContain('flat 0%');
  });

  it('handles empty top performers', () => {
    const noPerformers = {
      ...MOCK_SUMMARY,
      yesterday: { ...MOCK_SUMMARY.yesterday, top_performers: [] },
    };
    const result = formatProductionSection(noPerformers);
    expect(result).not.toContain('Top performers');
  });

  it('limits top performers to 5', () => {
    const manyPerformers = {
      ...MOCK_SUMMARY,
      yesterday: {
        ...MOCK_SUMMARY.yesterday,
        top_performers: Array.from({ length: 10 }, (_, i) => ({
          name: `Worker${i}`,
          pieces: 100 - i,
          goal_pct: 100 - i,
        })),
      },
    };
    const result = formatProductionSection(manyPerformers);
    expect(result).toContain('Worker0');
    expect(result).toContain('Worker4');
    expect(result).not.toContain('Worker5');
  });
});

describe('fetchProductionSummary', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns parsed data on successful response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(MOCK_SUMMARY),
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await fetchProductionSummary('https://scanner.example.com', 'test-key');
    expect(result).toEqual(MOCK_SUMMARY);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://scanner.example.com/api/production/summary',
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-API-Key': 'test-key',
        }),
      }),
    );
  });

  it('strips trailing slash from base URL', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(MOCK_SUMMARY),
    });
    vi.stubGlobal('fetch', mockFetch);

    await fetchProductionSummary('https://scanner.example.com/', 'test-key');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://scanner.example.com/api/production/summary',
      expect.anything(),
    );
  });

  it('returns null on non-200 response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    }));

    const result = await fetchProductionSummary('https://scanner.example.com', 'test-key');
    expect(result).toBeNull();
  });

  it('returns null on network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Connection refused')));

    const result = await fetchProductionSummary('https://scanner.example.com', 'test-key');
    expect(result).toBeNull();
  });

  it('returns null on timeout', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('Aborted', 'AbortError')));

    const result = await fetchProductionSummary('https://scanner.example.com', 'test-key');
    expect(result).toBeNull();
  });

  it('returns null on 401 unauthorized', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    }));

    const result = await fetchProductionSummary('https://scanner.example.com', 'wrong-key');
    expect(result).toBeNull();
  });
});

describe('buildBriefingPrompt with production data', () => {
  it('includes production section in briefing prompt', async () => {
    const { buildBriefingPrompt } = await import('../../src/briefing/generator.js');
    const productionText = formatProductionSection(MOCK_SUMMARY);
    const prompt = buildBriefingPrompt(
      [],
      { totalProcessed: 5, archived: 3, flaggedForReview: 2 },
      undefined,
      undefined,
      productionText,
    );
    expect(prompt).toContain('FACTORY PRODUCTION REPORT');
    expect(prompt).toContain('1,234');
  });

  it('omits production section when not provided', async () => {
    const { buildBriefingPrompt } = await import('../../src/briefing/generator.js');
    const prompt = buildBriefingPrompt(
      [],
      { totalProcessed: 5, archived: 3, flaggedForReview: 2 },
    );
    expect(prompt).not.toContain('FACTORY PRODUCTION');
  });
});
