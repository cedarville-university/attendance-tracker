// server/tests/routes/admin.test.ts
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyFormbody from '@fastify/formbody';
import { beforeEach, afterAll, describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { getTestDb, resetDb, closeTestDb } from '../support/db.js';
import { seedInstitutionAndCourse } from '../support/seed.js';
import { MockCanvasPlatform } from '../support/mock-canvas.js';
import { createSession } from '../../src/auth/session.js';
import { createRequireCsrf } from '../../src/auth/middleware.js';
import { createRequireAdmin, createAdminMutationPreHandlers } from '../../src/auth/admin-middleware.js';
import { registerAdminRoutes } from '../../src/routes/admin.js';
import { registerLtiJwksRoute } from '../../src/routes/lti-jwks.js';
import { loadSigningKeys, SigningKeyProvider } from '../../src/lti/signing-key-store.js';
import { institutions, ltiDeployments, ltiRegistrations, toolSigningKeys } from '../../src/database/schema.js';

const { db } = getTestDb();
const platform = new MockCanvasPlatform();
const APP_BASE_URL = 'https://app.test';
const SETUP_TOKEN = 'setup-token-abcdefghijklmnop';
const ADMIN_ROLE = 'http://purl.imsglobal.org/vocab/lis/v2/institution/role#Administrator';
const INSTRUCTOR_ROLE = 'http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor';

afterAll(() => closeTestDb());
beforeEach(async () => {
  await resetDb();
});

async function buildAdminApp(setupToken: string | undefined = SETUP_TOKEN): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  await app.register(fastifyFormbody);
  const provider = new SigningKeyProvider(await loadSigningKeys(db, undefined));
  const requireAdmin = createRequireAdmin({ db, setupToken });
  const requireCsrf = createRequireCsrf(APP_BASE_URL);
  registerLtiJwksRoute(app, provider);
  registerAdminRoutes(app, {
    db,
    requireAdmin,
    adminMutation: createAdminMutationPreHandlers(requireAdmin, requireCsrf),
    signingKeyProvider: provider,
    appBaseUrl: APP_BASE_URL,
    reloadSigningKeys: () => provider.reload(db, undefined),
  });
  return app;
}

const registrationBody = (over: Record<string, unknown> = {}) => ({
  institutionSlug: 'cedarville',
  institutionName: 'Cedarville University',
  issuer: 'https://canvas.test.instructure.com',
  clientId: 'client-123',
  oidcAuthEndpoint: 'https://sso.test.canvaslms.com/api/lti/authorize_redirect',
  tokenEndpoint: 'https://sso.test.canvaslms.com/login/oauth2/token',
  platformJwksUri: 'https://sso.test.canvaslms.com/api/lti/security/jwks',
  deploymentId: 'deploy-1',
  ...over,
});

async function seedAdminSession(roles: string[]) {
  const seeded = await seedInstitutionAndCourse(db, platform);
  const { token, csrfSecret } = await createSession(db, {
    institutionId: seeded.institutionId,
    deploymentId: seeded.deploymentRowId,
    ltiSubject: 'user-admin',
    displayName: 'Admin User',
    courseId: seeded.courseId,
    roles,
    ttlHours: 8,
  });
  return { token, csrfSecret };
}

describe('admin route auth', () => {
  it('401s with neither a session nor a setup token', async () => {
    const app = await buildAdminApp();
    const res = await app.inject({ method: 'GET', url: '/api/admin/registrations' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'admin_unauthorized' });
  });

  it('401s with a wrong x-setup-token', async () => {
    const app = await buildAdminApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/registrations',
      headers: { 'x-setup-token': 'nope' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('401s an Instructor-only session (not an Administrator)', async () => {
    const app = await buildAdminApp();
    const { token } = await seedAdminSession([INSTRUCTOR_ROLE]);
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/registrations',
      headers: { cookie: `attendance_session=${token}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('allows an Administrator-role session with no token', async () => {
    const app = await buildAdminApp();
    const { token } = await seedAdminSession([ADMIN_ROLE]);
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/registrations',
      headers: { cookie: `attendance_session=${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('registrations');
  });
});

describe('POST /api/admin/registrations (setup token path)', () => {
  it('upserts institution + registration + deployment, and a re-POST updates the endpoints', async () => {
    const app = await buildAdminApp();
    const headers = { 'x-setup-token': SETUP_TOKEN };

    const first = await app.inject({ method: 'POST', url: '/api/admin/registrations', headers, payload: registrationBody() });
    expect(first.statusCode).toBe(200);
    expect(first.json().registration).toMatchObject({
      issuer: 'https://canvas.test.instructure.com',
      clientId: 'client-123',
      tokenAudience: 'https://sso.test.canvaslms.com/login/oauth2/token', // defaulted to tokenEndpoint
      deployments: [{ deploymentId: 'deploy-1', enabled: true }],
    });

    expect(await db.select().from(institutions)).toHaveLength(1);
    expect(await db.select().from(ltiRegistrations)).toHaveLength(1);
    expect(await db.select().from(ltiDeployments)).toHaveLength(1);

    const second = await app.inject({
      method: 'POST',
      url: '/api/admin/registrations',
      headers,
      payload: registrationBody({ oidcAuthEndpoint: 'https://sso.example.com/authorize_redirect' }),
    });
    expect(second.statusCode).toBe(200);
    expect(await db.select().from(ltiRegistrations)).toHaveLength(1); // updated, not appended
    expect(second.json().registration.oidcAuthEndpoint).toBe('https://sso.example.com/authorize_redirect');
  });

  it('a session-path mutation still requires CSRF', async () => {
    const app = await buildAdminApp();
    const { token } = await seedAdminSession([ADMIN_ROLE]);
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/registrations',
      headers: { cookie: `attendance_session=${token}` }, // no origin / x-csrf-token
      payload: registrationBody(),
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('signing key', () => {
  it('rotate changes activeKid, /lti/jwks then serves the new key, and no response leaks the private PEM', async () => {
    const app = await buildAdminApp();
    const headers = { 'x-setup-token': SETUP_TOKEN };

    const before = await app.inject({ method: 'GET', url: '/api/admin/signing-key', headers });
    const beforeKid = before.json().activeKid;
    expect(JSON.stringify(before.json())).not.toContain('PRIVATE KEY');

    const rotated = await app.inject({ method: 'POST', url: '/api/admin/signing-key/rotate', headers });
    expect(rotated.statusCode).toBe(200);
    const afterKid = rotated.json().activeKid;
    expect(afterKid).not.toBe(beforeKid);
    expect(rotated.json().previousKids).toContain(beforeKid);
    expect(JSON.stringify(rotated.json())).not.toContain('PRIVATE KEY');

    const jwks = await app.inject({ method: 'GET', url: '/lti/jwks' });
    expect(jwks.json().keys.map((k: { kid: string }) => k.kid)).toContain(afterKid);

    // The stored PEM never appears in an API body.
    const rows = await db.select().from(toolSigningKeys).where(eq(toolSigningKeys.status, 'active'));
    expect(rows[0].privateKeyPkcs8Pem).toContain('PRIVATE KEY'); // it IS stored
  });
});
