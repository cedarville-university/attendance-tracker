import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyFormbody from '@fastify/formbody';
import { beforeEach, afterEach, afterAll, describe, it, expect } from 'vitest';
import { registerLtiLaunchRoute, type LtiLaunchRouteDeps } from '../../src/routes/lti-launch.js';
import { getTestDb, resetDb, closeTestDb } from '../support/db.js';
import { seedInstitutionAndRegistration } from '../support/seed.js';
import { MockCanvasPlatform } from '../support/mock-canvas.js';
import { createOidcTransaction } from '../../src/lti/oidc-transactions.js';
import { JwksCache } from '../../src/lti/jwks-cache.js';
import { appSessions } from '../../src/database/schema.js';

function buildTestApp(deps: LtiLaunchRouteDeps) {
  const app = Fastify({ logger: false });
  app.register(fastifyCookie);
  app.register(fastifyFormbody);
  registerLtiLaunchRoute(app, deps);
  return app;
}

// File scope so the shared module-level pg pool in db.ts is closed exactly once (see the same note
// in registrations.test.ts).
afterAll(async () => {
  await closeTestDb();
});

describe('POST /lti/launch', () => {
  let platform: MockCanvasPlatform;
  let jwksCache: JwksCache;

  beforeEach(async () => {
    await resetDb();
    platform = new MockCanvasPlatform();
    await platform.start();
    jwksCache = new JwksCache({ fetchJwks: (uri) => fetch(uri).then((r) => r.json()) });
  });
  afterEach(async () => {
    await platform.stop();
  });

  function deps(): LtiLaunchRouteDeps {
    return { db: getTestDb().db, jwksCache, clockSkewSeconds: 120, sessionTtlHours: 8, appBaseUrl: 'https://app.test' };
  }

  async function setUpValidTransaction(targetLinkUri = 'https://app.test/index.html') {
    const { db } = getTestDb();
    const seeded = await seedInstitutionAndRegistration(db, platform);
    return createOidcTransaction(db, {
      registrationId: seeded.registrationId,
      deploymentId: seeded.deploymentId,
      targetLinkUri,
      ttlSeconds: 300,
    });
  }

  it('redirects 303 to the transaction\'s target_link_uri and sets a Secure, HttpOnly session cookie on a valid launch', async () => {
    const created = await setUpValidTransaction();
    const idToken = await platform.mintIdToken({ nonce: created.nonce });
    const app = buildTestApp(deps());

    const response = await app.inject({
      method: 'POST',
      url: '/lti/launch',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ state: created.state, id_token: idToken }).toString(),
    });

    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe('https://app.test/index.html');
    const cookieHeader = response.headers['set-cookie'];
    expect(cookieHeader).toBeDefined();
    const cookieString = Array.isArray(cookieHeader) ? cookieHeader.join(';') : String(cookieHeader);
    expect(cookieString).toContain('attendance_session=');
    expect(cookieString).toContain('HttpOnly');
    expect(cookieString).toContain('Secure');
  });

  it('redirects to the SECOND allowlist entry when that is what the launch targeted', async () => {
    // ALLOWED_TARGET_LINK_URIS is a multi-entry list (see Task 2), so a launch aimed at
    // /scanner.html must land on /scanner.html, not on whichever entry happens to be first.
    const created = await setUpValidTransaction('https://app.test/scanner.html');
    const idToken = await platform.mintIdToken({ nonce: created.nonce });
    const app = buildTestApp(deps());

    const response = await app.inject({
      method: 'POST',
      url: '/lti/launch',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ state: created.state, id_token: idToken }).toString(),
    });

    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe('https://app.test/scanner.html');
  });

  it('§45 case 22 at the route level: returns 403 (not 400) for a learner-only launch, and creates no session', async () => {
    const created = await setUpValidTransaction();
    const idToken = await platform.mintIdToken({
      nonce: created.nonce,
      roles: ['http://purl.imsglobal.org/vocab/lis/v2/membership#Learner'],
    });
    const app = buildTestApp(deps());

    const response = await app.inject({
      method: 'POST',
      url: '/lti/launch',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ state: created.state, id_token: idToken }).toString(),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'learner_only_role' });
    expect(response.headers['set-cookie']).toBeUndefined();

    const { db } = getTestDb();
    expect(await db.select().from(appSessions)).toHaveLength(0);
  });

  it('returns 400 for a request missing both state and id_token, and creates no session', async () => {
    const app = buildTestApp(deps());

    const response = await app.inject({ method: 'POST', url: '/lti/launch', payload: {} });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'missing_state' });

    const { db } = getTestDb();
    expect(await db.select().from(appSessions)).toHaveLength(0);
  });

  it('§45 case 23 at the route level: returns 400 (not 403) for a tampered launch', async () => {
    const created = await setUpValidTransaction();
    const idToken = await platform.mintIdToken({ nonce: created.nonce });
    const [, payload, signature] = idToken.split('.');
    // Same deterministic corruption as the launch.ts unit test: a header segment that decodes to
    // text JSON.parse cannot parse, so decodeProtectedHeader throws reliably.
    const tamperedHeader = Buffer.from('not valid json').toString('base64url');
    const app = buildTestApp(deps());

    const response = await app.inject({
      method: 'POST',
      url: '/lti/launch',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ state: created.state, id_token: `${tamperedHeader}.${payload}.${signature}` }).toString(),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'tampered_token' });
  });
});
