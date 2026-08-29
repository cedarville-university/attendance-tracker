// server/tests/lifecycle.test.ts
import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import { installShutdownHandlers } from '../src/lifecycle.js';

function fakeApp() {
  return { close: vi.fn().mockResolvedValue(undefined), log: { info: vi.fn(), error: vi.fn() } };
}
function fakePool() {
  return { end: vi.fn().mockResolvedValue(undefined) };
}

describe('installShutdownHandlers', () => {
  it('closes the app then the pool then exits 0 on SIGTERM', async () => {
    const app = fakeApp();
    const pool = fakePool();
    const bus = new EventEmitter();
    const onExit = vi.fn();
    installShutdownHandlers(app as never, pool as never, { onExit, _process: bus });
    bus.emit('SIGTERM');
    await vi.waitFor(() => expect(onExit).toHaveBeenCalledWith(0));
    expect(app.close).toHaveBeenCalledOnce();
    expect(pool.end).toHaveBeenCalledOnce();
    expect(app.close.mock.invocationCallOrder[0]).toBeLessThan(pool.end.mock.invocationCallOrder[0]);
  });

  it('is idempotent — a second signal does not re-run shutdown', async () => {
    const app = fakeApp();
    const pool = fakePool();
    const bus = new EventEmitter();
    const onExit = vi.fn();
    installShutdownHandlers(app as never, pool as never, { onExit, _process: bus });
    bus.emit('SIGTERM');
    bus.emit('SIGTERM');
    await vi.waitFor(() => expect(onExit).toHaveBeenCalledWith(0));
    expect(app.close).toHaveBeenCalledOnce();
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it('forces exit 1 if app.close hangs past the timeout', async () => {
    vi.useFakeTimers();
    const app = { close: vi.fn(() => new Promise(() => {})), log: { info: vi.fn(), error: vi.fn() } };
    const pool = fakePool();
    const bus = new EventEmitter();
    const onExit = vi.fn();
    installShutdownHandlers(app as never, pool as never, { onExit, timeoutMs: 5000, _process: bus });
    bus.emit('SIGTERM');
    await vi.advanceTimersByTimeAsync(5001);
    expect(onExit).toHaveBeenCalledWith(1);
    vi.useRealTimers();
  });
});
