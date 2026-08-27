// server/tests/routes/lti-login.test.ts
import Fastify from 'fastify';
import fastifyFormbody from '@fastify/formbody';
import { describe, it, expect, vi } from 'vitest';
import { registerLtiLoginRoute } from '../../src/routes/lti-login.js';
import { createAllowlist, type LoginDeps } from '../../src/lti/login.js';

function buildTestApp(deps: LoginDeps) {
  const app = Fastify({ logger: false });
  app.register(fastifyFormbody);
  registerLtiLoginRoute(app, deps);
  return app;
}

function makeDeps(): LoginDeps {
  return {
    appBaseUrl: 'https://app.test',
    allowedTargetLinkUris: createAllowlist(['https://app.test/index.html']),
    findEnabledDeployment: vi.fn().mockResolvedValue({
      registration: { id: 'reg-1', oidcAuthEndpoint: 'https://canvas.test/authorize' },
      deployment: { id: 'dep-row-1', deploymentId: 'deploy-1' },
    }),
    createTransaction: vi.fn().mockResolvedValue({ state: 'state-value', nonce: 'nonce-value' }),
  };
}

const QUERY = {
  iss: 'https://canvas.test',
  login_hint: 'hint-123',
  target_link_uri: 'https://app.test/index.html',
  client_id: 'client-1',
  deployment_id: 'deploy-1',
};

describe('GET/POST /lti/login', () => {
  it('GET redirects (302) to the Canvas authorization endpoint on a valid request', async () => {
    const app = buildTestApp(makeDeps());
    const query = new URLSearchParams(QUERY).toString();

    const response = await app.inject({ method: 'GET', url: `/lti/login?${query}` });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain('https://canvas.test/authorize');
  });

  it('POST (form-encoded, per Canvas §12.1) also redirects on a valid request', async () => {
    const app = buildTestApp(makeDeps());

    const response = await app.inject({
      method: 'POST',
      url: '/lti/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams(QUERY).toString(),
    });

    expect(response.statusCode).toBe(302);
  });

  it('returns 400 for a request missing a required parameter', async () => {
    const app = buildTestApp(makeDeps());
    const { iss, ...missingIss } = QUERY;
    const query = new URLSearchParams(missingIss).toString();

    const response = await app.inject({ method: 'GET', url: `/lti/login?${query}` });

    expect(response.statusCode).toBe(400);
  });

  it('§45 case 24: returns 400 for a disallowed target_link_uri, never redirecting to it, and creating no OIDC transaction', async () => {
    const deps = makeDeps();
    const app = buildTestApp(deps);
    const query = new URLSearchParams({ ...QUERY, target_link_uri: 'https://evil.test/x' }).toString();

    const response = await app.inject({ method: 'GET', url: `/lti/login?${query}` });

    expect(response.statusCode).toBe(400);
    expect(response.headers.location).toBeUndefined();
    // Case 24 is the one §45 case that is rejected at LOGIN time, before any launch exists. The
    // matrix-wide "no app_sessions row" invariant is satisfied here structurally rather than by a
    // database count: /lti/login never creates a session (only /lti/launch does), and the
    // allowlist check runs before anything is written, so no oidc_transactions row is created
    // either. These two assertions pin exactly that.
    expect(deps.createTransaction).not.toHaveBeenCalled();
    expect(deps.findEnabledDeployment).not.toHaveBeenCalled();
  });
});
