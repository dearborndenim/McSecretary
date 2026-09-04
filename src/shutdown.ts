// Graceful shutdown for SIGTERM/SIGINT. Extracted from index.ts so the
// sequencing (stop bot -> stop server -> exit, with a fallback timer and a
// double-invocation guard) can be unit tested without booting the real app.

export interface ShutdownDeps {
  /** Stop whatever needs stopping (Telegram polling, cron jobs, etc). May be async. */
  stopBot: () => void | Promise<void>;
  /** Close the HTTP server. May be async. */
  stopServer: () => void | Promise<void>;
  /** Usually process.exit. Injected so tests don't kill the test runner. */
  exit: (code: number) => void;
  /**
   * Schedule the fallback forced-exit. Usually setTimeout. Injected so tests
   * can invoke the callback synchronously instead of waiting out the real timer.
   */
  setTimer: (callback: () => void, ms: number) => unknown;
  /** Fallback delay in ms before forcing exit if shutdown hangs. Defaults to 10s. */
  timeoutMs?: number;
}

/**
 * Builds a shutdown handler that runs stopBot and stopServer, then exits 0.
 * A fallback timer forces exit(0) if something hangs. Calling the returned
 * function more than once is a no-op after the first call.
 */
export function createShutdown(deps: ShutdownDeps): (signal?: string) => void {
  const { stopBot, stopServer, exit, setTimer, timeoutMs = 10_000 } = deps;
  let shuttingDown = false;
  let exited = false;

  // Both the fallback timer and the normal completion path race to exit;
  // whichever fires first wins and the other is a no-op.
  const doExit = (code: number) => {
    if (exited) return;
    exited = true;
    exit(code);
  };

  return (signal?: string) => {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`McSECREtary shutting down (${signal ?? 'SIGTERM'})`);

    setTimer(() => doExit(0), timeoutMs);

    void (async () => {
      try {
        await stopBot();
      } catch (err) {
        console.error('Error stopping bot during shutdown:', err);
      }
      try {
        await stopServer();
      } catch (err) {
        console.error('Error stopping server during shutdown:', err);
      }
      doExit(0);
    })();
  };
}
