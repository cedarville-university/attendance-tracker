// server/tests/telemetry/logger.test.ts
import { describe, it, expect } from 'vitest';
import { loggerOptions, SAFE_LOG_FIELDS, safeLogFields } from '../../src/telemetry/logger.js';

const env = (nodeEnv?: string) =>
  ({ NODE_ENV: nodeEnv, RUN_MIGRATIONS_ON_BOOT: false }) as unknown as import('../../src/config/env.js').Env;

describe('loggerOptions', () => {
  it('redacts authorization, cookie, token and card-code paths', () => {
    const opts = loggerOptions(env('production')) as { redact?: { paths: string[] } | string[] };
    const paths = Array.isArray(opts.redact) ? opts.redact : (opts.redact?.paths ?? []);
    for (const p of [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      '*.id_token',
      '*.client_secret',
      '*.cardCode',
      '*.access_token',
    ]) {
      expect(paths).toContain(p);
    }
  });

  it('uses pretty transport only outside production', () => {
    expect((loggerOptions(env('production')) as Record<string, unknown>).transport).toBeUndefined();
    expect((loggerOptions(env('development')) as Record<string, unknown>).transport).toBeDefined();
  });
});

describe('safeLogFields', () => {
  it('includes only the spec §44 allowlist, dropping anything else', () => {
    const fakeReq = { id: 'req-1', method: 'POST', url: '/api/x', routeOptions: { url: '/api/x' } };
    const out = safeLogFields(fakeReq as never, {
      httpStatus: 200,
      durationMs: 12,
      institutionId: 'inst-1',
      displayName: 'Jane Student', // must be dropped
      cardCode: 'ABC123', // must be dropped
    });
    expect(out).toHaveProperty('requestId', 'req-1');
    expect(out).toHaveProperty('httpStatus', 200);
    expect(out).toHaveProperty('institutionId', 'inst-1');
    expect(out).not.toHaveProperty('displayName');
    expect(out).not.toHaveProperty('cardCode');
  });

  it('exposes the allowlist as a stable constant', () => {
    expect(SAFE_LOG_FIELDS).toContain('requestId');
    expect(SAFE_LOG_FIELDS).toContain('attendanceSessionId');
    expect(SAFE_LOG_FIELDS).not.toContain('displayName');
  });
});
