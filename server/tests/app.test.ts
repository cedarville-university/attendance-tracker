// server/tests/app.test.ts
//
// Exercises the real Fastify middleware chain assembled by buildApp(env, deps): the helmet CSP
// (with the dynamic Canvas OIDC origin folded into form-action), the Permissions-Policy hook, and
// the encapsulated rate-limit scope (spec §31.10 — /lti/login + /lti/launch only, never the
// classroom scan endpoint). DB setup mirrors server/tests/routes/course-roster-integration.test.ts.
import { beforeEach, afterAll, describe, it, expect } from 'vitest';
import { getTestDb, resetDb, closeTestDb } from './support/db.js';
import { seedInstitutionAndRegistration } from './support/seed.js';
import { MockCanvasPlatform } from './support/mock-canvas.js';
import { loadSigningKeysFromEnv } from '../src/lti/signing-keys.js';
import { createDefaultJwksCache } from '../src/lti/jwks-cache.js';
import { MockIdentityResolver } from '../src/identity/mock-resolver.js';
import { loadEnv } from '../src/config/env.js';
import { buildApp } from '../src/app.js';

const baseEnv: Record<string, string> = {
  DATABASE_URL: 'unused-in-buildApp',
  APP_BASE_URL: 'https://app.test',
  ALLOWED_TARGET_LINK_URIS: 'https://app.test/index.html',
};

async function makeApp(overrides: Record<string, string> = {}) {
  const { db } = getTestDb();
  const env = loadEnv({ ...baseEnv, ...overrides });
  const app = await buildApp(env, {
    db,
    signingKeys: await loadSigningKeysFromEnv(undefined),
    jwksCache: createDefaultJwksCache(),
    identityResolver: new MockIdentityResolver(),
  });
  return app;
}

beforeEach(async () => {
  await resetDb();
});
afterAll(async () => {
  await closeTestDb();
});

describe('buildApp — security headers via the real middleware chain', () => {
  it('emits the locked-down CSP including the seeded Canvas OIDC origin in form-action', async () => {
    await seedInstitutionAndRegistration(getTestDb().db, new MockCanvasPlatform(), {
      oidcAuthEndpoint: 'https://canvas.example.test/api/lti/authorize_redirect',
    });
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/index.html' });
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'self' https://canvas.example.test");
    expect(res.headers['permissions-policy']).toBe('hid=(self)');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    await app.close();
  });

  it('omits upgrade-insecure-requests when APP_BASE_URL is http', async () => {
    const app = await makeApp({ APP_BASE_URL: 'http://localhost:3000' });
    const res = await app.inject({ method: 'GET', url: '/index.html' });
    expect(String(res.headers['content-security-policy'])).not.toContain('upgrade-insecure-requests');
    await app.close();
  });
});

describe('buildApp — rate-limit scoping (spec §31.10)', () => {
  it('rate-limits /lti/login but not the attendance scan endpoint', async () => {
    const app = await makeApp();
    let sawLimited = false;
    for (let i = 0; i < 35; i += 1) {
      const r = await app.inject({ method: 'POST', url: '/lti/login', payload: {} });
      if (r.statusCode === 429) sawLimited = true;
    }
    expect(sawLimited).toBe(true);

    for (let i = 0; i < 35; i += 1) {
      const r = await app.inject({ method: 'POST', url: '/api/attendance-sessions/does-not-exist/scans', payload: {} });
      expect(r.statusCode).not.toBe(429); // 401/404, never rate-limited
    }
    await app.close();
  });
});
