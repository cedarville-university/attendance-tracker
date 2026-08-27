// server/tests/lti/registrations.test.ts
import { beforeEach, afterAll, describe, it, expect } from 'vitest';
import { getTestDb, resetDb, closeTestDb } from '../support/db.js';
import { institutions, ltiRegistrations, ltiDeployments } from '../../src/database/schema.js';
import {
  findEnabledDeployment,
  findRegistrationById,
  findDeploymentByBusinessId,
  findOrCreateCourse,
} from '../../src/lti/registrations.js';

async function seedRow(overrides: { deploymentEnabled?: boolean } = {}) {
  const { db } = getTestDb();
  const [institution] = await db
    .insert(institutions)
    .values({ slug: 'cedarville', displayName: 'Cedarville University', timezone: 'America/New_York', enabled: true })
    .returning();
  const [registration] = await db
    .insert(ltiRegistrations)
    .values({
      institutionId: institution.id,
      issuer: 'https://canvas.instructure.com',
      clientId: 'client-1',
      oidcAuthEndpoint: 'https://canvas.instructure.com/api/lti/authorize_redirect',
      tokenEndpoint: 'https://canvas.instructure.com/login/oauth2/token',
      tokenAudience: 'https://canvas.instructure.com/login/oauth2/token',
      platformJwksUri: 'https://canvas.instructure.com/api/lti/security/jwks',
      enabled: true,
    })
    .returning();
  const [deployment] = await db
    .insert(ltiDeployments)
    .values({ registrationId: registration.id, deploymentId: 'deploy-1', enabled: overrides.deploymentEnabled ?? true, configuration: {} })
    .returning();
  return { institution, registration, deployment };
}

// File scope, not inside the first describe: db.ts's pg pool is module-level and shared by every
// describe below, so closing it from inside one describe would leave the pools the later describes
// re-create open (Vitest then warns about a hanging process).
afterAll(async () => {
  await closeTestDb();
});

describe('findEnabledDeployment', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns null when no matching registration exists', async () => {
    const { db } = getTestDb();
    const result = await findEnabledDeployment(db, 'https://unknown.test', 'client-x', 'deploy-x');
    expect(result).toBeNull();
  });

  it('returns institution/registration/deployment for a matching, enabled row set', async () => {
    const { db } = getTestDb();
    await seedRow();

    const result = await findEnabledDeployment(db, 'https://canvas.instructure.com', 'client-1', 'deploy-1');

    expect(result?.institution.slug).toBe('cedarville');
    expect(result?.registration.clientId).toBe('client-1');
    expect(result?.deployment.deploymentId).toBe('deploy-1');
  });

  it('returns null when the deployment is disabled', async () => {
    const { db } = getTestDb();
    await seedRow({ deploymentEnabled: false });

    const result = await findEnabledDeployment(db, 'https://canvas.instructure.com', 'client-1', 'deploy-1');
    expect(result).toBeNull();
  });
});

describe('findRegistrationById / findDeploymentByBusinessId', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('looks up a registration by its primary key and a deployment by its business deployment_id', async () => {
    const { db } = getTestDb();
    const { registration, deployment } = await seedRow();

    const foundRegistration = await findRegistrationById(db, registration.id);
    expect(foundRegistration?.issuer).toBe('https://canvas.instructure.com');

    const foundDeployment = await findDeploymentByBusinessId(db, registration.id, 'deploy-1');
    expect(foundDeployment?.id).toBe(deployment.id);

    expect(await findDeploymentByBusinessId(db, registration.id, 'no-such-deployment')).toBeNull();
  });
});

describe('findOrCreateCourse', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('creates a course on first call and reuses it on a second call with the same context', async () => {
    const { db } = getTestDb();
    const { institution, deployment } = await seedRow();

    const first = await findOrCreateCourse(db, {
      institutionId: institution.id,
      deploymentId: deployment.id,
      ltiContextId: 'course-abc',
      label: 'CS101',
      title: 'Intro to CS',
    });
    const second = await findOrCreateCourse(db, {
      institutionId: institution.id,
      deploymentId: deployment.id,
      ltiContextId: 'course-abc',
    });

    expect(second.id).toBe(first.id);
  });

  it('dedupes concurrent first-time calls for the same (deploymentId, ltiContextId) without throwing', async () => {
    const { db } = getTestDb();
    const { institution, deployment } = await seedRow();

    const params = {
      institutionId: institution.id,
      deploymentId: deployment.id,
      ltiContextId: 'course-concurrent',
      label: 'CS102',
      title: 'Data Structures',
    };

    const results = await Promise.all([
      findOrCreateCourse(db, params),
      findOrCreateCourse(db, params),
      findOrCreateCourse(db, params),
      findOrCreateCourse(db, params),
      findOrCreateCourse(db, params),
    ]);

    const ids = results.map((r) => r.id);
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toBeTruthy();
  });
});
