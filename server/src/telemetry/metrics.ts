// server/src/telemetry/metrics.ts
//
// The spec §44 metric set as OpenTelemetry instruments. metrics.getMeter() returns a no-op meter
// until startTelemetry() installs a MeterProvider, so importing this module and calling .add()/
// .record() is always safe (tests do exactly that).

import { metrics as otelMetrics, type ObservableResult } from '@opentelemetry/api';

const meter = otelMetrics.getMeter('attendance-tracker');

let pendingGradeJobs = 0;
let failedGradeJobs = 0;

const pendingGauge = meter.createObservableGauge('grade_jobs.pending', {
  description: 'Grade-sync jobs awaiting a successful Canvas post',
});
const failedGauge = meter.createObservableGauge('grade_jobs.failed', {
  description: 'Grade-sync jobs that have exhausted retries',
});
pendingGauge.addCallback((r: ObservableResult) => r.observe(pendingGradeJobs));
failedGauge.addCallback((r: ObservableResult) => r.observe(failedGradeJobs));

export function setGradeJobGauges(pending: number, failed: number): void {
  pendingGradeJobs = pending;
  failedGradeJobs = failed;
}

export const metrics = {
  ltiLaunch: meter.createCounter('lti.launch', { description: 'LTI launch attempts by result/reason' }),
  nrpsLatencyMs: meter.createHistogram('nrps.latency', { unit: 'ms' }),
  nrpsErrors: meter.createCounter('nrps.errors'),
  identityLookupLatencyMs: meter.createHistogram('identity_lookup.latency', { unit: 'ms' }),
  identityLookupErrors: meter.createCounter('identity_lookup.errors'),
  scans: meter.createCounter('scan.count'),
  unexpectedScans: meter.createCounter('scan.unexpected'),
  lookupErrors: meter.createCounter('scan.lookup_errors'),
  sessionClose: meter.createCounter('attendance.session_close'),
  agsLatencyMs: meter.createHistogram('ags.latency', { unit: 'ms' }),
  agsErrors: meter.createCounter('ags.errors'),
  dbLatencyMs: meter.createHistogram('db.latency', { unit: 'ms' }),
  http5xx: meter.createCounter('http.server.5xx'),
  httpRequestLatencyMs: meter.createHistogram('http.server.duration', { unit: 'ms' }),
} as const;
