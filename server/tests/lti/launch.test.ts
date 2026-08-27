import { beforeEach, afterEach, afterAll, describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { getTestDb, resetDb, closeTestDb } from '../support/db.js';
import { seedInstitutionAndRegistration } from '../support/seed.js';
import { MockCanvasPlatform } from '../support/mock-canvas.js';
import { createOidcTransaction } from '../../src/lti/oidc-transactions.js';
import { ltiDeployments } from '../../src/database/schema.js';
import { resolveTransactionContext } from '../../src/lti/launch.js';

// File scope, NOT inside a describe: Tasks 20-23 append four more describes to this same file, and
// db.ts's pg pool is module-level and shared by all of them. Closing it from inside the first
// describe would leave the pool the later describes re-create open (Vitest then warns about a
// hanging process). Do not move this into a describe when appending the later blocks.
afterAll(async () => {
  await closeTestDb();
});

describe('resolveTransactionContext', () => {
  let platform: MockCanvasPlatform;

  beforeEach(async () => {
    await resetDb();
    platform = new MockCanvasPlatform();
    await platform.start();
  });
  afterEach(async () => {
    await platform.stop();
  });

  it('§45 case 3: propagates unknown_state', async () => {
    const { db } = getTestDb();
    expect(await resolveTransactionContext(db, 'never-issued')).toEqual({ ok: false, reason: 'unknown_state' });
  });

  it('§45 case 4: propagates expired_state', async () => {
    const { db } = getTestDb();
    const seeded = await seedInstitutionAndRegistration(db, platform);
    const created = await createOidcTransaction(db, {
      registrationId: seeded.registrationId,
      deploymentId: seeded.deploymentId,
      targetLinkUri: 'https://app.test/index.html',
      ttlSeconds: -1,
    });
    expect(await resolveTransactionContext(db, created.state)).toEqual({ ok: false, reason: 'expired_state' });
  });

  it('§45 case 5: propagates reused_state on a second call for the same state', async () => {
    const { db } = getTestDb();
    const seeded = await seedInstitutionAndRegistration(db, platform);
    const created = await createOidcTransaction(db, {
      registrationId: seeded.registrationId,
      deploymentId: seeded.deploymentId,
      targetLinkUri: 'https://app.test/index.html',
      ttlSeconds: 300,
    });

    expect((await resolveTransactionContext(db, created.state)).ok).toBe(true);
    expect(await resolveTransactionContext(db, created.state)).toEqual({ ok: false, reason: 'reused_state' });
  });

  it('resolves the registration and deployment for a valid, unconsumed transaction', async () => {
    const { db } = getTestDb();
    const seeded = await seedInstitutionAndRegistration(db, platform);
    const created = await createOidcTransaction(db, {
      registrationId: seeded.registrationId,
      deploymentId: seeded.deploymentId,
      targetLinkUri: 'https://app.test/index.html',
      ttlSeconds: 300,
    });

    const result = await resolveTransactionContext(db, created.state);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.context.registration.clientId).toBe(seeded.clientId);
      expect(result.context.deployment.deploymentId).toBe(seeded.deploymentId);
    }
  });

  it('§45 case 17 (deployment-disabled variant): rejects when the deployment was disabled after the transaction was created', async () => {
    const { db } = getTestDb();
    const seeded = await seedInstitutionAndRegistration(db, platform);
    const created = await createOidcTransaction(db, {
      registrationId: seeded.registrationId,
      deploymentId: seeded.deploymentId,
      targetLinkUri: 'https://app.test/index.html',
      ttlSeconds: 300,
    });

    await db.update(ltiDeployments).set({ enabled: false }).where(eq(ltiDeployments.deploymentId, seeded.deploymentId));

    expect(await resolveTransactionContext(db, created.state)).toEqual({ ok: false, reason: 'wrong_deployment' });
  });
});
