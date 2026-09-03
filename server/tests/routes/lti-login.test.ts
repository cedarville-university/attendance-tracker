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
  lti_deployment_id: 'deploy-1',
  lti_message_hint: 'msg-hint-abc',
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

describe('/lti/login — real Canvas login-initiation payload', () => {
  // Field names captured verbatim from a real Canvas (test env) OIDC login POST to /lti/login
  // during Phase 7 Task 22 verification (HAR, 2026-08-31). Opaque values are replaced; the point
  // of this fixture is the *parameter names*. Note `lti_deployment_id` — the LTI 1.3 OIDC
  // login-initiation spelling — not the bare `deployment_id` claim name that appears in the launch
  // id_token. spec §12.1's parameter list said `deployment_id`; real Canvas does not send that.
  const CANVAS_LOGIN_POST = {
    iss: 'https://canvas.test.instructure.com',
    login_hint: 'REDACTED-LOGIN-HINT',
    client_id: '126240000000000360',
    lti_deployment_id: '4695:REDACTED',
    target_link_uri: 'https://app.test/index.html',
    // JWT-shaped (dots, `_`, `-`) so the assertion also proves URLSearchParams round-trips it
    // unmangled; real value redacted.
    lti_message_hint: 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJ2ZXJpZmllciI6InJlZGFjdGVkIn0.AbC_-dEf123',
    canvas_environment: 'test',
    canvas_region: 'us-east-1',
    lti_storage_target: 'post_message_forwarding',
  };

  it('redirects (302) on the exact parameter set Canvas sends, resolving lti_deployment_id', async () => {
    const deps = makeDeps();
    const app = buildTestApp(deps);

    const response = await app.inject({
      method: 'POST',
      url: '/lti/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams(CANVAS_LOGIN_POST).toString(),
    });

    expect(response.statusCode).toBe(302);
    expect(deps.findEnabledDeployment).toHaveBeenCalledWith(
      'https://canvas.test.instructure.com',
      '126240000000000360',
      '4695:REDACTED',
    );
    // Canvas rejects the authorization redirect ("lti_message_hint is missing") unless the tool
    // echoes the hint it received on the login initiation, verbatim.
    const location = new URL(response.headers.location as string);
    expect(location.searchParams.get('lti_message_hint')).toBe(CANVAS_LOGIN_POST.lti_message_hint);
    expect(location.searchParams.get('prompt')).toBe('none');
  });

  it('rejects (400) a payload missing `lti_message_hint`', async () => {
    const deps = makeDeps();
    const app = buildTestApp(deps);
    const { lti_message_hint, ...rest } = CANVAS_LOGIN_POST;

    const response = await app.inject({
      method: 'POST',
      url: '/lti/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams(rest).toString(),
    });

    expect(response.statusCode).toBe(400);
    expect(deps.findEnabledDeployment).not.toHaveBeenCalled();
  });

  it('rejects (400) a payload carrying the bare `deployment_id` claim name instead of `lti_deployment_id`', async () => {
    const deps = makeDeps();
    const app = buildTestApp(deps);
    const { lti_deployment_id, ...rest } = CANVAS_LOGIN_POST;
    const payload = new URLSearchParams({ ...rest, deployment_id: lti_deployment_id }).toString();

    const response = await app.inject({
      method: 'POST',
      url: '/lti/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload,
    });

    expect(response.statusCode).toBe(400);
    expect(deps.findEnabledDeployment).not.toHaveBeenCalled();
  });
});
