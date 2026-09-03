// server/tests/maintenance/purge.test.ts
import { randomUUID } from 'node:crypto';
import { beforeEach, afterAll, describe, it, expect } from 'vitest';
import { getTestDb, resetDb, closeTestDb } from '../support/db.js';
import { runMaintenancePass } from '../../src/maintenance/purge.js';
import { institutions, ltiRegistrations, oidcTransactions } from '../../src/database/schema.js';

const { db } = getTestDb();

beforeEach(async () => {
  await resetDb();
});
afterAll(async () => {
  await closeTestDb();
});

// oidc_transactions.registration_id carries an enforced FK to lti_registrations.id, so seed a
// real institution + registration first (the brief's gen_random_uuid() placeholder would violate
// the constraint). The NOT NULL set on oidc_transactions is:
//   registration_id, deployment_id, state_hash, nonce_hash, target_link_uri, expires_at
async function seedRegistrationId(): Promise<string> {
  const [institution] = await db
    .insert(institutions)
    .values({ slug: `purge-${randomUUID()}`, displayName: 'Purge Test', timezone: 'UTC', enabled: true })
    .returning();
  const [registration] = await db
    .insert(ltiRegistrations)
    .values({
      institutionId: institution.id,
      issuer: 'https://purge.test',
      clientId: `client-${randomUUID()}`,
      oidcAuthEndpoint: 'https://purge.test/authorize',
      tokenEndpoint: 'https://purge.test/token',
      tokenAudience: 'https://purge.test/token',
      platformJwksUri: 'https://purge.test/jwks',
      enabled: true,
    })
    .returning();
  return registration.id;
}

async function seedExpiredOidc(): Promise<void> {
  const registrationId = await seedRegistrationId();
  await db.insert(oidcTransactions).values({
    registrationId,
    deploymentId: `dep-${randomUUID()}`,
    stateHash: `state-${randomUUID()}`,
    nonceHash: `nonce-${randomUUID()}`,
    targetLinkUri: 'https://app/x',
    expiresAt: new Date(Date.now() - 60 * 60 * 1000),
  });
}

describe('runMaintenancePass', () => {
  it('deletes expired oidc_transactions and app_sessions, leaves live rows', async () => {
    await seedExpiredOidc();
    const before = await db.select().from(oidcTransactions);
    expect(before.length).toBe(1);
    const result = await runMaintenancePass(db, {});
    expect(result.oidcPurged).toBe(1);
    const after = await db.select().from(oidcTransactions);
    expect(after.length).toBe(0);
  });

  it('is a no-op for retention when retentionDays is unset', async () => {
    const result = await runMaintenancePass(db, {});
    expect(result.retentionDeleted).toBe(0);
  });

  it('stops early when shouldStop returns true', async () => {
    await seedExpiredOidc();
    const result = await runMaintenancePass(db, { shouldStop: () => true });
    // stopped before the oidc delete step
    expect(result.oidcPurged).toBe(0);
  });
});
