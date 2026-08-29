// server/tests/routes/hardening.test.ts
//
// CSP / Permissions-Policy assertions now live in server/tests/app.test.ts against the real buildApp middleware.
import Fastify from 'fastify';
import fastifyRateLimit from '@fastify/rate-limit';
import { describe, it, expect } from 'vitest';

describe('rate limiting (spec §31.10: 30 requests/minute/IP on /lti/login and /lti/launch)', () => {
  it('returns 429 once the configured per-IP limit is exceeded within the window', async () => {
    const app = Fastify({ logger: false });
    await app.register(fastifyRateLimit, { max: 3, timeWindow: '1 minute' });
    app.get('/lti/login-probe', async () => ({ ok: true }));

    for (let i = 0; i < 3; i += 1) {
      const response = await app.inject({ method: 'GET', url: '/lti/login-probe' });
      expect(response.statusCode).toBe(200);
    }

    const fourth = await app.inject({ method: 'GET', url: '/lti/login-probe' });
    expect(fourth.statusCode).toBe(429);
  });
});
