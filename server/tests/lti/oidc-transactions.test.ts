import { beforeEach, afterAll, describe, it, expect } from 'vitest';
import { getTestDb, resetDb, closeTestDb } from '../support/db.js';
import { institutions, ltiRegistrations } from '../../src/database/schema.js';
import { createOidcTransaction, consumeOidcTransaction } from '../../src/lti/oidc-transactions.js';

async function seedRegistrationId(): Promise<string> {
  const { db } = getTestDb();
  const [institution] = await db
    .insert(institutions)
    .values({ slug: 'txn-test', displayName: 'Txn Test', timezone: 'UTC', enabled: true })
    .returning();
  const [registration] = await db
    .insert(ltiRegistrations)
    .values({
      institutionId: institution.id,
      issuer: 'https://txn.test',
      clientId: 'txn-client',
      oidcAuthEndpoint: 'https://txn.test/authorize',
      tokenEndpoint: 'https://txn.test/token',
      tokenAudience: 'https://txn.test/token',
      platformJwksUri: 'https://txn.test/jwks',
      enabled: true,
    })
    .returning();
  return registration.id;
}

// File scope so the shared module-level pg pool in db.ts is closed exactly once, after every
// describe in this file has finished (see the same note in registrations.test.ts).
afterAll(async () => {
  await closeTestDb();
});

describe('createOidcTransaction / consumeOidcTransaction', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('creates a transaction with 256-bit state/nonce and consumes it successfully once', async () => {
    const { db } = getTestDb();
    const registrationId = await seedRegistrationId();

    const created = await createOidcTransaction(db, {
      registrationId,
      deploymentId: 'deploy-1',
      targetLinkUri: 'https://app.test/index.html',
      ttlSeconds: 300,
    });

    expect(Buffer.from(created.state, 'base64url').length).toBeGreaterThanOrEqual(32);
    expect(Buffer.from(created.nonce, 'base64url').length).toBeGreaterThanOrEqual(32);

    const result = await consumeOidcTransaction(db, created.state);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.transaction.registrationId).toBe(registrationId);
      expect(result.transaction.deploymentId).toBe('deploy-1');
    }
  });

  it('§45 case 3: rejects an unknown state', async () => {
    const { db } = getTestDb();
    const result = await consumeOidcTransaction(db, 'never-issued-state-value');
    expect(result).toEqual({ ok: false, reason: 'unknown_state' });
  });

  it('§45 case 4: rejects an expired state', async () => {
    const { db } = getTestDb();
    const registrationId = await seedRegistrationId();
    const created = await createOidcTransaction(db, {
      registrationId,
      deploymentId: 'deploy-1',
      targetLinkUri: 'https://app.test/index.html',
      ttlSeconds: -1, // already expired
    });

    const result = await consumeOidcTransaction(db, created.state);
    expect(result).toEqual({ ok: false, reason: 'expired_state' });
  });

  it('§45 case 5: rejects a reused state on the second consume', async () => {
    const { db } = getTestDb();
    const registrationId = await seedRegistrationId();
    const created = await createOidcTransaction(db, {
      registrationId,
      deploymentId: 'deploy-1',
      targetLinkUri: 'https://app.test/index.html',
      ttlSeconds: 300,
    });

    const first = await consumeOidcTransaction(db, created.state);
    expect(first.ok).toBe(true);

    const second = await consumeOidcTransaction(db, created.state);
    expect(second).toEqual({ ok: false, reason: 'reused_state' });
  });
});
