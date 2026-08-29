import { describe, it, expect } from 'vitest';
import { metrics, setGradeJobGauges } from '../../src/telemetry/metrics.js';

describe('metrics instruments', () => {
  it('exposes every spec §44 instrument and they are callable without a configured exporter', () => {
    expect(() => {
      metrics.ltiLaunch.add(1, { result: 'success' });
      metrics.nrpsLatencyMs.record(42);
      metrics.agsErrors.add(1, { kind: 'rate-limited' });
      metrics.scans.add(1);
      metrics.http5xx.add(1, { route: '/api/x' });
      setGradeJobGauges(3, 1);
    }).not.toThrow();
  });
});
