import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyFormbody from '@fastify/formbody';
import { beforeEach, afterEach, afterAll, describe, it, expect } from 'vitest';
import { registerLtiLaunchRoute } from '../../src/routes/lti-launch.js';
import { getTestDb, resetDb, closeTestDb } from '../support/db.js';
import { seedInstitutionAndRegistration } from '../support/seed.js';
import { MockCanvasPlatform } from '../support/mock-canvas.js';
import { createOidcTransaction } from '../../src/lti/oidc-transactions.js';
import { JwksCache } from '../../src/lti/jwks-cache.js';
import { courses } from '../../src/database/schema.js';

const NRPS_CLAIM = 'https://purl.imsglobal.org/spec/lti-nrps/claim/namesroleservice';
const AGS_CLAIM = 'https://purl.imsglobal.org/spec/lti-ags/claim/endpoint';

afterAll(async () => {
  await closeTestDb();
});

describe('launch persists NRPS/AGS service endpoints (Phase 3 retrofit)', () => {
  let platform: MockCanvasPlatform;
  let jwksCache: JwksCache;
  let seeded: Awaited<ReturnType<typeof seedInstitutionAndRegistration>>;

  beforeEach(async () => {
    await resetDb();
    platform = new MockCanvasPlatform();
    await platform.start();
    jwksCache = new JwksCache({ fetchJwks: (uri) => fetch(uri).then((r) => r.json()) });
    // Seed the institution / registration / deployment ONCE per test. seedInstitutionAndRegistration
    // inserts an lti_registrations row keyed by unique(issuer, clientId) — both fixed constants — so a
    // second call inside the same test throws; and two deployment UUIDs would create two courses rows.
    // Each launch() below reuses this single registration/deployment and only mints a fresh OIDC
    // transaction + id_token, so repeated launches of the same context update ONE courses row in place.
    seeded = await seedInstitutionAndRegistration(getTestDb().db, platform);
  });
  afterEach(async () => {
    await platform.stop();
  });

  function buildTestApp() {
    const app = Fastify({ logger: false });
    app.register(fastifyCookie);
    app.register(fastifyFormbody);
    registerLtiLaunchRoute(app, {
      db: getTestDb().db,
      jwksCache,
      clockSkewSeconds: 120,
      sessionTtlHours: 8,
      appBaseUrl: 'https://app.test',
    });
    return app;
  }

  async function launch(extraClaims: Record<string, unknown>) {
    const { db } = getTestDb();
    // No re-seed here — `seeded` is created once in beforeEach. Each call only mints a fresh OIDC
    // transaction + id_token against the already-seeded institution/registration/deployment.
    const tx = await createOidcTransaction(db, {
      registrationId: seeded.registrationId,
      deploymentId: seeded.deploymentId,
      targetLinkUri: 'https://app.test/index.html',
      ttlSeconds: 300,
    });
    const idToken = await platform.mintIdToken({ nonce: tx.nonce, deploymentId: seeded.deploymentId, extraClaims });
    const res = await buildTestApp().inject({
      method: 'POST',
      url: '/lti/launch',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ state: tx.state, id_token: idToken }).toString(),
    });
    expect(res.statusCode).toBe(303);
    return db;
  }

  it('persists courses.nrpsUrl / agsLineitemsUrl / lastLaunchedAt from the launch claims', async () => {
    const db = await launch({
      [NRPS_CLAIM]: { context_memberships_url: 'https://canvas.example.edu/api/lti/courses/1/names_and_roles' },
      [AGS_CLAIM]: { lineitems: 'https://canvas.example.edu/api/lti/courses/1/line_items', scope: [] },
    });
    const [course] = await db.select().from(courses);
    expect(course.nrpsUrl).toBe('https://canvas.example.edu/api/lti/courses/1/names_and_roles');
    expect(course.agsLineitemsUrl).toBe('https://canvas.example.edu/api/lti/courses/1/line_items');
    expect(course.lastLaunchedAt).not.toBeNull();
  });

  it('leaves nrpsUrl / agsLineitemsUrl null when the launch omits those claims, and still succeeds', async () => {
    const db = await launch({});
    const [course] = await db.select().from(courses);
    expect(course.nrpsUrl).toBeNull();
    expect(course.agsLineitemsUrl).toBeNull();
    expect(course.lastLaunchedAt).not.toBeNull();
  });

  it('refreshes a rotated nrpsUrl on the next launch of the same course', async () => {
    await launch({ [NRPS_CLAIM]: { context_memberships_url: 'https://canvas.example.edu/nrps/v1' } });
    const db = await launch({ [NRPS_CLAIM]: { context_memberships_url: 'https://canvas.example.edu/nrps/v2' } });
    const rows = await db.select().from(courses);
    expect(rows).toHaveLength(1);
    expect(rows[0].nrpsUrl).toBe('https://canvas.example.edu/nrps/v2');
  });
});
