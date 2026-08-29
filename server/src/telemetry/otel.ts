// server/src/telemetry/otel.ts
//
// Starts the Azure Monitor OpenTelemetry distribution (traces + metrics + logs -> Application
// Insights) when APPLICATIONINSIGHTS_CONNECTION_STRING is set. A no-op otherwise, so local dev and
// the test suite import metrics.ts safely. MUST be called before any other local import does I/O --
// index.ts and worker.ts await it as their first statement.
//
// startTelemetry() is async so the Azure dependency can be loaded with a native ESM `await import()`
// -- it is only pulled in when a connection string is actually configured. Callers must `await` it.

let started = false;

export async function startTelemetry(): Promise<void> {
  if (started) return;
  started = true;
  const connectionString = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
  if (!connectionString) return;
  // Imported lazily so the dependency is only loaded when actually configured.
  const { useAzureMonitor } = await import('@azure/monitor-opentelemetry');
  useAzureMonitor({
    azureMonitorExporterOptions: { connectionString },
    samplingRatio: Number(process.env.OTEL_SAMPLING_RATIO ?? '1'),
  });
}
