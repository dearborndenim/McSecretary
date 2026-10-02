import { describe, it, expect, vi } from 'vitest';
import { createShutdown, type ShutdownDeps } from '../src/shutdown.js';

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
};

function fakes(overrides: Partial<ShutdownDeps> = {}) {
  const order: string[] = [];
  const logs: string[] = [];
  let timerCallback: (() => void) | undefined;
  const deps = {
    closeServer: vi.fn(async () => { order.push('server'); }),
    stopBot: vi.fn(async () => { order.push('bot'); }),
    stopCron: vi.fn(() => { order.push('cron'); }),
    closeDb: vi.fn(() => { order.push('db'); }),
    exit: vi.fn(),
    setTimer: vi.fn((cb: () => void, _ms: number) => { timerCallback = cb; return 1; }),
    log: (msg: string) => logs.push(msg),
    logError: vi.fn(),
    ...overrides,
  };
  return { deps, order, logs, fireTimer: () => timerCallback?.() };
}

describe('createShutdown', () => {
  it('closes server, bot, cron and db once each, db last, then exits 0', async () => {
    const { deps, order } = fakes();
    createShutdown(deps)('SIGTERM');
    await flush();

    for (const fn of [deps.closeServer, deps.stopBot, deps.stopCron, deps.closeDb]) {
      expect(fn).toHaveBeenCalledTimes(1);
    }
    expect(order[order.length - 1]).toBe('db');
    expect(deps.setTimer).toHaveBeenCalledWith(expect.any(Function), 8_000);
    expect(deps.exit).toHaveBeenCalledTimes(1);
    expect(deps.exit).toHaveBeenCalledWith(0);
  });

  it('still exits 0 when a close throws, and closes the rest', async () => {
    const { deps } = fakes({ stopBot: vi.fn(async () => { throw new Error('409 conflict'); }) });
    createShutdown(deps)('SIGTERM');
    await flush();

    expect(deps.closeDb).toHaveBeenCalledTimes(1);
    expect(deps.logError).toHaveBeenCalledTimes(1);
    expect(deps.exit).toHaveBeenCalledWith(0);
  });

  it('a hanging server does not block bot and cron; the timeout exits 0 and names what is open', async () => {
    const { deps, logs, fireTimer } = fakes({ closeServer: vi.fn(() => new Promise<void>(() => {})) });
    createShutdown(deps)('SIGTERM');
    await flush();

    expect(deps.stopBot).toHaveBeenCalledTimes(1);
    expect(deps.stopCron).toHaveBeenCalledTimes(1);
    expect(deps.closeDb).not.toHaveBeenCalled();
    expect(deps.exit).not.toHaveBeenCalled();

    fireTimer();
    expect(deps.exit).toHaveBeenCalledTimes(1);
    expect(deps.exit).toHaveBeenCalledWith(0);
    expect(logs.join('\n')).toMatch(/still open: http server\b/);
  });

  it('a second signal during shutdown does nothing', async () => {
    const { deps, fireTimer } = fakes();
    const shutdown = createShutdown(deps);
    shutdown('SIGTERM');
    shutdown('SIGINT');
    await flush();
    fireTimer(); // timer firing after a clean exit must not exit again

    for (const fn of [deps.closeServer, deps.stopBot, deps.stopCron, deps.closeDb, deps.setTimer, deps.exit]) {
      expect(fn).toHaveBeenCalledTimes(1);
    }
  });
});
