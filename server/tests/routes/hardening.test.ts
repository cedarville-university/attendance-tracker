// server/tests/routes/hardening.test.ts
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import { describe, it, expect } from 'vitest';

// buildCspDirectives + buildHardenedApp mirror, line for line, the helmet configuration and the
// Permissions-Policy hook in server/src/index.ts (Step 4 below). Keep the two in sync.
function buildCspDirectives(appBaseUrl: string, canvasOidcOrigins: string[]): Record<string, string[] | null> {
  const directives: Record<string, string[] | null> = {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'"],
    connectSrc: ["'self'"],
    objectSrc: ["'none'"],
    baseUri: ["'none'"],
    // Spec §31.3 asks for `form-action 'self' <configured Canvas OIDC destinations>`. The app's own
    // origin is covered by 'self'; the extra entries are the origins of the oidc_auth_endpoint
    // values in lti_registrations, because /lti/login sends the browser on to the platform's
    // authorization endpoint and Canvas form-POSTs the launch back.
    formAction: ["'self'", ...canvasOidcOrigins],
    frameAncestors: ["'none'"],
  };
  if (!appBaseUrl.startsWith('https://')) {
    // Helmet's default CSP includes `upgrade-insecure-requests`, which makes the browser rewrite
    // every http://localhost:3000 request to https:// and breaks local HTTP development. `null` is
    // helmet's documented way to remove one of its own default directives.
    directives.upgradeInsecureRequests = null;
  }
  return directives;
}

async function buildHardenedApp(appBaseUrl: string, canvasOidcOrigins: string[]): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: { directives: buildCspDirectives(appBaseUrl, canvasOidcOrigins) },
  });
  // Spec §31.2. Helmet does not set Permissions-Policy, and this app is a WebHID card scanner, so
  // it must explicitly grant `hid` to its own origin (and to nothing embedded).
  app.addHook('onRequest', async (_request, reply) => {
    reply.header('Permissions-Policy', 'hid=(self)');
  });
  app.get('/probe', async () => ({ ok: true }));
  return app;
}

describe('security headers (helmet, spec §31.2/§31.3)', () => {
  it('sets a restrictive CSP with frame-ancestors none, plus X-Content-Type-Options', async () => {
    const app = await buildHardenedApp('https://app.test', ['https://canvas.test']);

    const response = await app.inject({ method: 'GET', url: '/probe' });

    const csp = String(response.headers['content-security-policy']);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });

  it("names the configured Canvas OIDC destinations in form-action, not just the app's own origin", async () => {
    const app = await buildHardenedApp('https://app.test', ['https://canvas.test', 'https://canvas-beta.test']);

    const response = await app.inject({ method: 'GET', url: '/probe' });

    expect(String(response.headers['content-security-policy'])).toContain(
      "form-action 'self' https://canvas.test https://canvas-beta.test",
    );
  });

  it('sets Permissions-Policy: hid=(self) so the WebHID scanner keeps working (spec §31.2)', async () => {
    const app = await buildHardenedApp('https://app.test', ['https://canvas.test']);

    const response = await app.inject({ method: 'GET', url: '/probe' });

    expect(response.headers['permissions-policy']).toBe('hid=(self)');
  });

  it('omits upgrade-insecure-requests for an http APP_BASE_URL, keeps it for https', async () => {
    const httpApp = await buildHardenedApp('http://localhost:3000', ['https://canvas.test']);
    const httpsApp = await buildHardenedApp('https://app.test', ['https://canvas.test']);

    const httpResponse = await httpApp.inject({ method: 'GET', url: '/probe' });
    const httpsResponse = await httpsApp.inject({ method: 'GET', url: '/probe' });

    expect(String(httpResponse.headers['content-security-policy'])).not.toContain('upgrade-insecure-requests');
    expect(String(httpsResponse.headers['content-security-policy'])).toContain('upgrade-insecure-requests');
  });
});

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
