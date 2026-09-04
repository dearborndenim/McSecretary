import { describe, it, expect, vi } from 'vitest';
import { createShutdown } from '../src/shutdown.js';

describe('createShutdown', () => {
  it('stops the bot and server once each, then exits 0', async () => {
    const stopBot = vi.fn().mockResolvedValue(undefined);
    const stopServer = vi.fn().mockResolvedValue(undefined);
    const exit = vi.fn();
    const setTimer = vi.fn();

    const shutdown = createShutdown({ stopBot, stopServer, exit, setTimer });
    shutdown('SIGTERM');

    // Let the internal async IIFE's microtasks/awaits flush.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(stopBot).toHaveBeenCalledTimes(1);
    expect(stopServer).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('forces exit 0 via the fallback timer if shutdown hangs', () => {
    const stopBot = vi.fn(() => new Promise(() => {})); // never resolves
    const stopServer = vi.fn().mockResolvedValue(undefined);
    const exit = vi.fn();
    let firedCallback: (() => void) | undefined;
    const setTimer = vi.fn((callback: () => void, _ms: number) => {
      firedCallback = callback;
      return 'timer-handle';
    });

    const shutdown = createShutdown({ stopBot, stopServer, exit, setTimer, timeoutMs: 10_000 });
    shutdown('SIGTERM');

    expect(setTimer).toHaveBeenCalledWith(expect.any(Function), 10_000);
    // Simulate the fallback timer firing before stopBot ever resolves.
    firedCallback?.();

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('is a no-op on a second call', async () => {
    const stopBot = vi.fn().mockResolvedValue(undefined);
    const stopServer = vi.fn().mockResolvedValue(undefined);
    const exit = vi.fn();
    const setTimer = vi.fn();

    const shutdown = createShutdown({ stopBot, stopServer, exit, setTimer });
    shutdown('SIGTERM');
    shutdown('SIGINT');

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(stopBot).toHaveBeenCalledTimes(1);
    expect(stopServer).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(setTimer).toHaveBeenCalledTimes(1);
  });
});
