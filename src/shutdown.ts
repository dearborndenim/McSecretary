// Graceful shutdown for SIGTERM/SIGINT. Extracted from index.ts so the
// sequencing can be unit tested without booting the real app.
//
// Order: the HTTP server, Telegram polling and the cron jobs are stopped in
// parallel (a slow keep-alive request must not keep polling alive), then the
// SQLite database is closed last so no in-flight request or handler writes to
// a closed handle. A fallback timer exits 0 regardless and logs whatever had
// not finished. Exit is always 0: Railway reports a non-zero exit of an
// outgoing deployment to GitHub as a failed deployment.

export interface ShutdownDeps {
  /** Stop accepting HTTP connections; resolve once the server has closed. */
  closeServer: () => void | Promise<void>;
  /** Stop the Telegram long-polling loop. */
  stopBot: () => void | Promise<void>;
  /** Stop every scheduled cron task. */
  stopCron: () => void | Promise<void>;
  /** Close the SQLite database. Runs after the other three have settled. */
  closeDb: () => void | Promise<void>;
  /** Usually process.exit. Injected so tests don't kill the test runner. */
  exit: (code: number) => void;
  /** Schedule the fallback forced exit. Usually setTimeout. */
  setTimer: (callback: () => void, ms: number) => unknown;
  /** Fallback delay before forcing exit. Defaults to 8 s. */
  timeoutMs?: number;
  log?: (msg: string) => void;
  logError?: (msg: string, err: unknown) => void;
}

/**
 * Builds the shutdown handler. Every close runs at most once; a second call
 * (a second signal) is a no-op.
 */
export function createShutdown(deps: ShutdownDeps): (signal?: string) => void {
  const {
    exit,
    setTimer,
    timeoutMs = 8_000,
    log = (msg) => console.log(msg),
    logError = (msg, err) => console.error(msg, err),
  } = deps;
  let shuttingDown = false;
  let exited = false;
  const pending = new Set<string>();

  const doExit = () => {
    if (exited) return;
    exited = true;
    exit(0);
  };

  const run = async (name: string, fn: () => void | Promise<void>) => {
    pending.add(name);
    try {
      await fn();
    } catch (err) {
      logError(`Shutdown: ${name} failed to close:`, err);
    } finally {
      pending.delete(name);
    }
  };

  return (signal?: string) => {
    if (shuttingDown) {
      log(`McSECREtary already shutting down; ignoring ${signal ?? 'signal'}`);
      return;
    }
    shuttingDown = true;
    log(`McSECREtary shutting down (${signal ?? 'SIGTERM'})`);

    setTimer(() => {
      if (exited) return;
      const left = pending.size > 0 ? [...pending].join(', ') : 'database (not reached)';
      log(`Shutdown timed out after ${timeoutMs} ms; still open: ${left}. Exiting 0.`);
      doExit();
    }, timeoutMs);

    void (async () => {
      await Promise.all([
        run('http server', deps.closeServer),
        run('telegram bot', deps.stopBot),
        run('cron jobs', deps.stopCron),
      ]);
      await run('database', deps.closeDb);
      if (!exited) log('McSECREtary shutdown complete');
      doExit();
    })();
  };
}
