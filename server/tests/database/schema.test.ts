import { beforeEach, afterAll, describe, it, expect } from 'vitest';
import { getTestDb, resetDb, closeTestDb } from '../support/db.js';
import { institutions, ltiRegistrations, ltiDeployments, courses, appSessions, oidcTransactions } from '../../src/database/schema.js';

// File scope, not inside a describe: the pg pool in tests/support/db.ts is module-level and shared
// by every describe in this file, so closing it from inside one describe would leave any later
// describe's re-created pool open (Vitest then warns about a hanging process).
afterAll(async () => {
  await closeTestDb();
});

describe('schema smoke test', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('can insert and read a full row chain across every Phase 3 table', async () => {
    const { db } = getTestDb();

    const [institution] = await db
      .insert(institutions)
      .values({ slug: 'smoke-test', displayName: 'Smoke Test University', timezone: 'UTC', enabled: true })
      .returning();
    expect(institution.id).toBeTruthy();

    const [registration] = await db
      .insert(ltiRegistrations)
      .values({
        institutionId: institution.id,
        issuer: 'https://smoke.test',
        clientId: 'client-smoke',
        oidcAuthEndpoint: 'https://smoke.test/authorize',
        tokenEndpoint: 'https://smoke.test/token',
        tokenAudience: 'https://smoke.test/token',
        platformJwksUri: 'https://smoke.test/jwks',
        enabled: true,
      })
      .returning();

    const [deployment] = await db
      .insert(ltiDeployments)
      .values({ registrationId: registration.id, deploymentId: 'deploy-smoke', enabled: true, configuration: {} })
      .returning();

    const [transaction] = await db
      .insert(oidcTransactions)
      .values({
        registrationId: registration.id,
        deploymentId: deployment.deploymentId,
        stateHash: 'state-hash-smoke',
        nonceHash: 'nonce-hash-smoke',
        targetLinkUri: 'https://smoke.test/index.html',
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      })
      .returning();
    expect(transaction.consumedAt).toBeNull();

    const [course] = await db
      .insert(courses)
      .values({ institutionId: institution.id, deploymentId: deployment.id, ltiContextId: 'course-smoke', label: 'SMOKE101', title: 'Smoke Course' })
      .returning();

    const [session] = await db
      .insert(appSessions)
      .values({
        sessionTokenHash: 'session-hash-smoke',
        institutionId: institution.id,
        deploymentId: deployment.id,
        ltiSubject: 'user-smoke',
        courseId: course.id,
        roles: ['Instructor'],
        csrfSecret: 'csrf-smoke',
        expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000),
      })
      .returning();

    expect(session.ltiSubject).toBe('user-smoke');
    expect(session.roles).toEqual(['Instructor']);
  });

  it('enforces UNIQUE(issuer, client_id) on lti_registrations', async () => {
    const { db } = getTestDb();
    const [institution] = await db
      .insert(institutions)
      .values({ slug: 'dup-test', displayName: 'Dup Test', timezone: 'UTC', enabled: true })
      .returning();

    const values = {
      institutionId: institution.id,
      issuer: 'https://dup.test',
      clientId: 'client-dup',
      oidcAuthEndpoint: 'https://dup.test/authorize',
      tokenEndpoint: 'https://dup.test/token',
      tokenAudience: 'https://dup.test/token',
      platformJwksUri: 'https://dup.test/jwks',
      enabled: true,
    };
    await db.insert(ltiRegistrations).values(values);

    await expect(db.insert(ltiRegistrations).values(values)).rejects.toThrow();
  });
});
