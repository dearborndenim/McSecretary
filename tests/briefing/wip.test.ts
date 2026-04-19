import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  fetchWipSummary,
  formatWipSection,
  type WipSummary,
} from '../../src/briefing/wip.js';

const MOCK_WIP: WipSummary = {
  as_of: '2026-04-18T03:00:00Z',
  total_in_flight: 235,
  oldest_wip_age_hours: 42.5,
  pieces_by_operation: { cut: 120, sew: 80, hem: 35 },
};

describe('formatWipSection', () => {
  it('renders totals + oldest age + per-operation lines when data is available', () => {
    const text = formatWipSection(MOCK_WIP);
    expect(text).toContain('WORK IN PROGRESS');
    expect(text).toContain('As of: 2026-04-18T03:00:00Z');
    expect(text).toContain('235');
    expect(text).toContain('42.5 hours');
    expect(text).toContain('cut: 120');
    expect(text).toContain('sew: 80');
    expect(text).toContain('hem: 35');
  });

  it('sorts operations descending by count so the biggest stage surfaces first', () => {
    const text = formatWipSection(MOCK_WIP);
    const cutIdx = text.indexOf('cut:');
    const sewIdx = text.indexOf('sew:');
    const hemIdx = text.indexOf('hem:');
    expect(cutIdx).toBeGreaterThan(-1);
    expect(cutIdx).toBeLessThan(sewIdx);
    expect(sewIdx).toBeLessThan(hemIdx);
  });

  it('returns an unavailable message when data is null', () => {
    const text = formatWipSection(null);
    expect(text).toContain('WORK IN PROGRESS');
    expect(text).toContain('unavailable');
  });

  it('handles an empty operations map without crashing', () => {
    const text = formatWipSection({
      as_of: '2026-04-18T03:00:00Z',
      total_in_flight: 0,
      oldest_wip_age_hours: 0,
      pieces_by_operation: {},
    });
    expect(text).toContain('WORK IN PROGRESS');
    expect(text).toContain('Total pieces in flight: 0');
    expect(text).not.toContain('By operation:');
  });

  it('formats large numbers with locale separators', () => {
    const text = formatWipSection({
      ...MOCK_WIP,
      total_in_flight: 12345,
      pieces_by_operation: { cut: 10000, sew: 2000 },
    });
    expect(text).toContain('12,345');
    expect(text).toContain('cut: 10,000');
  });
});

describe('fetchWipSummary', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns parsed data on successful response and uses Bearer auth', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(MOCK_WIP),
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await fetchWipSummary('https://scanner.example.com', 'test-key');
    expect(result).toEqual(MOCK_WIP);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://scanner.example.com/api/integration/wip-summary',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer test-key' }),
      }),
    );
  });

  it('returns null when baseUrl is blank (missing config)', async () => {
    const result = await fetchWipSummary('', 'test-key');
    expect(result).toBeNull();
  });

  it('returns null when apiKey is blank (missing config)', async () => {
    const result = await fetchWipSummary('https://scanner.example.com', '');
    expect(result).toBeNull();
  });

  it('returns null on 4xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    }));
    const result = await fetchWipSummary('https://scanner.example.com', 'test-key');
    expect(result).toBeNull();
  });

  it('returns null on 5xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
    }));
    const result = await fetchWipSummary('https://scanner.example.com', 'test-key');
    expect(result).toBeNull();
  });

  it('returns null on network error / timeout', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));
    const result = await fetchWipSummary('https://scanner.example.com', 'test-key');
    expect(result).toBeNull();
  });

  it('returns null on malformed payload (missing total_in_flight)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        as_of: '2026-04-18T03:00:00Z',
        oldest_wip_age_hours: 1,
        pieces_by_operation: {},
      }),
    }));
    const result = await fetchWipSummary('https://scanner.example.com', 'test-key');
    expect(result).toBeNull();
  });

  it('returns null on malformed payload (pieces_by_operation is not object)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        as_of: '2026-04-18T03:00:00Z',
        total_in_flight: 10,
        oldest_wip_age_hours: 1,
        pieces_by_operation: null,
      }),
    }));
    const result = await fetchWipSummary('https://scanner.example.com', 'test-key');
    expect(result).toBeNull();
  });

  it('strips trailing slash from base URL', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(MOCK_WIP),
    });
    vi.stubGlobal('fetch', mockFetch);

    await fetchWipSummary('https://scanner.example.com/', 'test-key');
    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toBe('https://scanner.example.com/api/integration/wip-summary');
  });

  it('uses a 5s timeout via AbortSignal', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(MOCK_WIP),
    });
    vi.stubGlobal('fetch', mockFetch);

    await fetchWipSummary('https://scanner.example.com', 'test-key');
    const opts = mockFetch.mock.calls[0][1] as RequestInit;
    expect(opts.signal).toBeDefined();
    // AbortSignal.timeout returns an AbortSignal; we can't directly read the
    // timeout, but we can confirm the signal exists and is not aborted yet.
    expect((opts.signal as AbortSignal).aborted).toBe(false);
  });
});
