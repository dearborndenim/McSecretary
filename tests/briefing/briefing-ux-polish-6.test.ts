/**
 * Briefing UX polish 6 — 2026-04-28.
 *
 * Two sub-features on top of /briefing-sections:
 *   1. --history --json flag for programmatic consumers
 *   2. Ping-pong revert pattern detection in maybeFireRevertAlert
 *      (alternating revert/set in trailing 24h, ≥ N flips fires a separate
 *      warning; shares the per-user 12h cooldown with the existing
 *      revert-spike alert; opt-out via DISABLE_BRIEFING_REVERT_ALERT=1).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import {
  createUser,
  insertBriefingSectionsAudit,
} from '../../src/db/user-queries.js';
import { parseBriefingSectionsCommand } from '../../src/briefing/sections-command.js';
import {
  maybeFireRevertAlert,
  countPingpongFlips,
  _resetRevertAlertCooldownForTesting,
} from '../../src/briefing/revert-alert.js';

// ============================================================================
// Parser — --history --json modifier + mutual exclusion
// ============================================================================
describe('Polish 6 — parser: --history --json', () => {
  it('parses --history --json with --user', () => {
    const a = parseBriefingSectionsCommand(
      '/briefing-sections --user=Olivier --history --json',
    );
    expect(a.matched).toBe(true);
    expect(a.history).toBe(true);
    expect(a.json).toBe(true);
  });

  it('parses --history --json --days=14', () => {
    const a = parseBriefingSectionsCommand(
      '/briefing-sections --user=Olivier --history --json --days=14',
    );
    expect(a.matched).toBe(true);
    expect(a.history).toBe(true);
    expect(a.json).toBe(true);
    expect(a.historyDays).toBe(14);
  });

  it('rejects --json without --history', () => {
    expect(
      parseBriefingSectionsCommand(
        '/briefing-sections --user=Olivier --json',
      ).matched,
    ).toBe(false);
  });

  it('rejects --json combined with non-history actions', () => {
    expect(
      parseBriefingSectionsCommand(
        '/briefing-sections --user=Olivier --set=calendar --json',
      ).matched,
    ).toBe(false);
    expect(
      parseBriefingSectionsCommand(
        '/briefing-sections --user=Olivier --reset --json',
      ).matched,
    ).toBe(false);
    expect(
      parseBriefingSectionsCommand(
        '/briefing-sections --user=Olivier --diff --json',
      ).matched,
    ).toBe(false);
    expect(
      parseBriefingSectionsCommand(
        '/briefing-sections --user=Olivier --revert --json',
      ).matched,
    ).toBe(false);
    expect(
      parseBriefingSectionsCommand(
        '/briefing-sections --list --json',
      ).matched,
    ).toBe(false);
    expect(
      parseBriefingSectionsCommand(
        '/briefing-sections --set-all=calendar --apply-to=all --json',
      ).matched,
    ).toBe(false);
    expect(
      parseBriefingSectionsCommand(
        '/briefing-sections --user=Eve --clone-from=Bob --json',
      ).matched,
    ).toBe(false);
  });

  it('rejects --json appearing twice', () => {
    expect(
      parseBriefingSectionsCommand(
        '/briefing-sections --user=Olivier --history --json --json',
      ).matched,
    ).toBe(false);
  });

  it('bare --history (no --json) still works', () => {
    const a = parseBriefingSectionsCommand(
      '/briefing-sections --user=Olivier --history',
    );
    expect(a.matched).toBe(true);
    expect(a.history).toBe(true);
    expect(a.json).toBeUndefined();
  });
});

// ============================================================================
// countPingpongFlips — pure helper
// ============================================================================
describe('Polish 6 — countPingpongFlips', () => {
  it('returns 0 for an empty array', () => {
    expect(countPingpongFlips([])).toBe(0);
  });

  it('returns 0 for monotonic reverts (no flips)', () => {
    expect(
      countPingpongFlips([
        { action: 'revert' },
        { action: 'revert' },
        { action: 'revert' },
      ]),
    ).toBe(0);
  });

  it('returns 0 for monotonic sets (no flips)', () => {
    expect(
      countPingpongFlips([
        { action: 'set' },
        { action: 'set' },
        { action: 'set' },
      ]),
    ).toBe(0);
  });

  it('counts flips in alternating set/revert/set/revert', () => {
    // set -> revert (flip 1), revert -> set (flip 2),
    // set -> revert (flip 3), revert -> set (flip 4)
    expect(
      countPingpongFlips([
        { action: 'set' },
        { action: 'revert' },
        { action: 'set' },
        { action: 'revert' },
        { action: 'set' },
      ]),
    ).toBe(4);
  });

  it('skips non-set/non-revert actions without breaking the chain', () => {
    expect(
      countPingpongFlips([
        { action: 'set' },
        { action: 'reset' }, // skipped — not set/revert
        { action: 'revert' },
        { action: 'clone-from' }, // skipped
        { action: 'set' },
      ]),
    ).toBe(2);
  });
});

// ============================================================================
// maybeFireRevertAlert — ping-pong path
// ============================================================================
describe('Polish 6 — maybeFireRevertAlert ping-pong path', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
    createUser(db, { id: 'oli', name: 'Olivier', email: 'oli@x.com', role: 'member' });
    _resetRevertAlertCooldownForTesting();
  });

  /**
   * Seed `count` alternating audit rows ending with `endingAction`.
   * Rows are inserted with timestamps spaced 60s apart, ending at `now`.
   * The alternating pattern between `set` and `revert` produces (count - 1)
   * flips when count >= 2.
   */
  function seedAlternating(
    count: number,
    now: Date,
    endingAction: 'set' | 'revert',
  ) {
    const rows: Array<'set' | 'revert'> = [];
    let cur = endingAction;
    for (let i = 0; i < count; i++) {
      rows.unshift(cur);
      cur = cur === 'set' ? 'revert' : 'set';
    }
    for (let i = 0; i < count; i++) {
      const ts = new Date(now.getTime() - (count - 1 - i) * 60_000).toISOString();
      const action = rows[i] as 'set' | 'revert';
      insertBriefingSectionsAudit(db, {
        ts,
        user_name: 'Olivier',
        action,
        sections_json: action === 'set' ? JSON.stringify(['calendar']) : null,
      });
    }
  }

  it('fires ping-pong alert when flips >= threshold (default 4)', async () => {
    const now = new Date('2026-04-28T12:00:00Z');
    // 5 alternating rows = 4 flips, ending on revert.
    seedAlternating(5, now, 'revert');
    const sent: string[] = [];
    const result = await maybeFireRevertAlert(db, 'Olivier', {
      now: () => now,
      env: {},
      sendMessage: async (text) => {
        sent.push(text);
      },
      console: { log: () => {}, error: () => {} },
    });
    expect(result.fired).toBe(true);
    expect(result.reason).toBe('fired_pingpong');
    expect(result.pingpongFlips).toBe(4);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('Ping-pong');
    expect(sent[0]).toContain('4 flips');
    expect(sent[0]).toContain('Olivier');
  });

  it('does NOT fire ping-pong when flips < threshold', async () => {
    const now = new Date('2026-04-28T12:00:00Z');
    // 4 alternating rows = 3 flips. Default threshold is 4 → below.
    seedAlternating(4, now, 'revert');
    const result = await maybeFireRevertAlert(db, 'Olivier', {
      now: () => now,
      env: {},
      console: { log: () => {}, error: () => {} },
    });
    // Note: 4 alternating rows include 2 reverts (count = 2), so
    // count <= threshold (3) keeps the standard alert silent too.
    expect(result.fired).toBe(false);
    expect(result.reason).toBe('below_threshold');
    expect(result.pingpongFlips).toBeUndefined();
  });

  it('respects BRIEFING_REVERT_PINGPONG_THRESHOLD env override', async () => {
    const now = new Date('2026-04-28T12:00:00Z');
    // 3 alternating rows = 2 flips. Default threshold is 4 → would not fire.
    // With threshold=2 it should fire.
    seedAlternating(3, now, 'revert');
    const result = await maybeFireRevertAlert(db, 'Olivier', {
      now: () => now,
      env: { BRIEFING_REVERT_PINGPONG_THRESHOLD: '2' },
      console: { log: () => {}, error: () => {} },
    });
    expect(result.fired).toBe(true);
    expect(result.reason).toBe('fired_pingpong');
    expect(result.pingpongFlips).toBe(2);
  });

  it('shares cooldown w/ revert-spike alert (one fire blocks both for 12h)', async () => {
    const now1 = new Date('2026-04-28T12:00:00Z');
    // First: trigger the count-based revert-spike alert (4 reverts, no sets).
    for (let i = 0; i < 4; i++) {
      const ts = new Date(now1.getTime() - i * 60_000).toISOString();
      insertBriefingSectionsAudit(db, {
        ts,
        user_name: 'Olivier',
        action: 'revert',
        sections_json: null,
      });
    }
    const first = await maybeFireRevertAlert(db, 'Olivier', {
      now: () => now1,
      env: {},
      console: { log: () => {}, error: () => {} },
    });
    expect(first.fired).toBe(true);
    expect(first.reason).toBe('fired');

    // Now simulate a ping-pong pattern arising 30 min later — within cooldown.
    // Add several `set` rows interleaved to bump flips above 4. Use timestamps
    // at now2 - 30*60_000 .. now2 to keep them inside the 24h window.
    const now2 = new Date('2026-04-28T12:30:00Z');
    // Insert 4 more alternating rows ending now2.
    const seq: Array<'set' | 'revert'> = ['set', 'revert', 'set', 'revert'];
    for (let i = 0; i < seq.length; i++) {
      const ts = new Date(now2.getTime() - (seq.length - 1 - i) * 30_000).toISOString();
      const action = seq[i] as 'set' | 'revert';
      insertBriefingSectionsAudit(db, {
        ts,
        user_name: 'Olivier',
        action,
        sections_json: action === 'set' ? JSON.stringify(['calendar']) : null,
      });
    }
    const second = await maybeFireRevertAlert(db, 'Olivier', {
      now: () => now2,
      env: {},
      console: { log: () => {}, error: () => {} },
    });
    // Cooldown blocks the second fire even though ping-pong now would qualify.
    expect(second.fired).toBe(false);
    expect(second.reason).toBe('cooldown');
  });

  it('DISABLE_BRIEFING_REVERT_ALERT=1 also disables ping-pong', async () => {
    const now = new Date('2026-04-28T12:00:00Z');
    seedAlternating(7, now, 'revert'); // 6 flips, well above 4
    const result = await maybeFireRevertAlert(db, 'Olivier', {
      now: () => now,
      env: { DISABLE_BRIEFING_REVERT_ALERT: '1' },
      console: { log: () => {}, error: () => {} },
    });
    expect(result.fired).toBe(false);
    expect(result.reason).toBe('disabled');
  });

  it('monotonic reverts do NOT trigger ping-pong (only the count alert)', async () => {
    const now = new Date('2026-04-28T12:00:00Z');
    // 5 reverts only — 0 flips. Count alert fires (5 > 3), but ping-pong
    // path should NOT.
    for (let i = 0; i < 5; i++) {
      const ts = new Date(now.getTime() - i * 60_000).toISOString();
      insertBriefingSectionsAudit(db, {
        ts,
        user_name: 'Olivier',
        action: 'revert',
        sections_json: null,
      });
    }
    const result = await maybeFireRevertAlert(db, 'Olivier', {
      now: () => now,
      env: {},
      console: { log: () => {}, error: () => {} },
    });
    expect(result.fired).toBe(true);
    expect(result.reason).toBe('fired');
    // Standard count message — NOT a ping-pong message.
    expect(result.message).not.toContain('Ping-pong');
    expect(result.message).toContain('5 times');
  });
});
