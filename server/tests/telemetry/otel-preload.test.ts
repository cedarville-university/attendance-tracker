import { describe, it, expect, vi, afterEach } from 'vitest';

// otel-preload.ts is the `node --import` preload. Its one unit-testable contract: importing it with
// APPLICATIONINSIGHTS_CONNECTION_STRING unset must resolve without throwing and must NOT pull in
// @azure/monitor-opentelemetry (startTelemetry() early-returns in that state). Real span emission is
// the live post-deploy check against App Insights, not something a unit test can assert.
describe('otel-preload', () => {
  const original = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;

  afterEach(() => {
    if (original === undefined) delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
    else process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = original;
    vi.resetModules();
    vi.doUnmock('@azure/monitor-opentelemetry');
  });

  it('imports without throwing and without loading @azure/monitor-opentelemetry when no connection string is set', async () => {
    delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
    vi.resetModules();

    const useAzureMonitor = vi.fn();
    vi.doMock('@azure/monitor-opentelemetry', () => ({ useAzureMonitor }));

    await expect(import('../../src/telemetry/otel-preload.js')).resolves.toBeDefined();
    expect(useAzureMonitor).not.toHaveBeenCalled();

    // startTelemetry() stays a safe idempotent no-op afterwards.
    const { startTelemetry } = await import('../../src/telemetry/otel.js');
    await expect(startTelemetry()).resolves.toBeUndefined();
    expect(useAzureMonitor).not.toHaveBeenCalled();
  });
});
