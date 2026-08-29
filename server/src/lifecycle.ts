// server/src/lifecycle.ts
//
// Graceful shutdown for the web process (spec §38 "implement graceful SIGTERM shutdown").
// Container Apps sends SIGTERM before evicting a replica; Fastify's app.close() stops accepting
// new connections and lets in-flight requests finish, then the pg pool is drained. A hard timeout
// guards against a hung close.

import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';

/**
 * The subset of `process` this module uses. A test can pass its own EventEmitter here (the
 * `_process` seam) and drive shutdown by emitting a signal on it, without touching the real
 * `process`.
 */
interface SignalBus {
  on(event: string, listener: () => void): unknown;
}

interface ShutdownOpts {
  timeoutMs?: number;
  signals?: NodeJS.Signals[];
  onExit?: (code: number) => void;
  /** Test seam — an EventEmitter-like object to listen on instead of `process`. */
  _process?: SignalBus;
}

export function installShutdownHandlers(app: FastifyInstance, pool: Pool, opts: ShutdownOpts = {}): void {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const signals = opts.signals ?? (['SIGTERM', 'SIGINT'] as NodeJS.Signals[]);
  const onExit = opts.onExit ?? ((code: number) => process.exit(code));
  const bus: SignalBus = opts._process ?? process;

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return; // idempotent: a second signal must not re-run the drain
    shuttingDown = true;
    app.log.info({ signal }, 'shutdown: draining');
    const hard = setTimeout(() => {
      app.log.error('shutdown: timed out, forcing exit');
      onExit(1);
    }, timeoutMs);
    hard.unref?.();
    void (async () => {
      try {
        await app.close();
        await pool.end();
        clearTimeout(hard);
        app.log.info('shutdown: clean');
        onExit(0);
      } catch (err) {
        clearTimeout(hard);
        app.log.error({ err: err instanceof Error ? err.message : 'unknown' }, 'shutdown: error');
        onExit(1);
      }
    })();
  };

  for (const signal of signals) bus.on(signal, () => shutdown(signal));
}
