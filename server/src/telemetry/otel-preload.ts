// server/src/telemetry/otel-preload.ts
//
// The `node --import ./server/dist/telemetry/otel-preload.js` preload for the compiled entrypoints
// (web + worker; the wiring lives in the Dockerfile CMD and the web / worker-job bicep `command`
// arrays). The `migrate` one-shot deliberately runs without it.
//
// Why a preload: the app is pure ESM ("type": "module", `node server/dist/index.js`). Azure Monitor's
// HTTP / Fastify / pg auto-instrumentation works by intercepting module loading via
// import-in-the-middle, which can only wrap a module the FIRST time it is imported. Calling
// startTelemetry() from inside index.ts / worker.ts runs after `fastify`, `pg`, `node:http` etc. are
// already in the module registry, so nothing gets wrapped and App Insights sees zero requests /
// dependencies / server spans. `node --import` fully settles this module's graph (top-level await
// included) before the main entry graph evaluates, so telemetry starts first.
//
// Two steps, in order:
//   1. Register the OpenTelemetry ESM loader hook (`@opentelemetry/instrumentation/hook.mjs`). The
//      @azure/monitor-opentelemetry 1.19 README makes this a separate step from useAzureMonitor()
//      (`node --import @azure/monitor-opentelemetry/loader ...`); useAzureMonitor() does not register
//      the hook itself. We register it directly with node:module so this preload does not have to
//      import the Azure package when there is no connection string (see step 2 / the import-safety
//      test). Mirrors what @azure/monitor-opentelemetry/loader does internally.
//   2. Delegate to startTelemetry(), which is the single guarded entry to useAzureMonitor(). It
//      early-returns when APPLICATIONINSIGHTS_CONNECTION_STRING is unset and only then lazily
//      `await import()`s @azure/monitor-opentelemetry, so importing this preload with no connection
//      string neither throws nor pulls in the Azure dependency.
//
// index.ts / worker.ts still `await startTelemetry()` as their first statement: that covers the
// loader-less `tsx` dev path (`npm run dev`), and is an idempotent no-op here because otel.ts's
// module-level `started` flag is already set by this preload.

import * as nodeModule from 'node:module';

// Node 22+ (module.register). Guard + best-effort like @azure/monitor-opentelemetry/loader so the
// preload can never crash the process over a hook it does not strictly need in dev.
const register = (nodeModule as { register?: (specifier: string, parentURL: string | URL) => unknown })
  .register;
if (typeof register === 'function') {
  try {
    register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);
  } catch {
    // best effort — auto-instrumentation simply stays off if the hook can't register
  }
}

import { startTelemetry } from './otel.js';

await startTelemetry();
