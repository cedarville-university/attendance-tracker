import { beforeEach, afterEach, afterAll, describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { getTestDb, resetDb, closeTestDb } from '../support/db.js';
import { seedInstitutionAndRegistration } from '../support/seed.js';
import { MockCanvasPlatform } from '../support/mock-canvas.js';
import { createOidcTransaction } from '../../src/lti/oidc-transactions.js';
import { ltiDeployments } from '../../src/database/schema.js';
import { resolveTransactionContext, validateAudienceAndLifetime } from '../../src/lti/launch.js';
import { JwksCache } from '../../src/lti/jwks-cache.js';
import { verifyJwtSignature } from '../../src/lti/launch.js';
import type { LtiRegistration } from '../../src/lti/types.js';

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

function registrationFor(platform: MockCanvasPlatform, clientId = 'mock-client-id'): LtiRegistration {
  return {
    id: 'reg-1',
    institutionId: 'inst-1',
    issuer: platform.issuer,
    clientId,
    oidcAuthEndpoint: 'https://mock-canvas.test/authorize',
    tokenEndpoint: 'https://mock-canvas.test/token',
    tokenAudience: 'https://mock-canvas.test/token',
    platformJwksUri: platform.jwksUri,
    enabled: true,
  };
}

/** Rewrites only the `kid` field of a signed token's header, leaving payload/signature untouched. */
function withHeaderKid(token: string, kid: string): string {
  const [headerSegment, payloadSegment, signatureSegment] = token.split('.');
  const header = JSON.parse(Buffer.from(headerSegment, 'base64url').toString('utf8')) as Record<string, unknown>;
  const newHeaderSegment = Buffer.from(JSON.stringify({ ...header, kid })).toString('base64url');
  return `${newHeaderSegment}.${payloadSegment}.${signatureSegment}`;
}

describe('verifyJwtSignature', () => {
  let platform: MockCanvasPlatform;
  let jwksCache: JwksCache;

  beforeEach(async () => {
    platform = new MockCanvasPlatform();
    await platform.start();
    jwksCache = new JwksCache({ fetchJwks: (uri) => fetch(uri).then((r) => r.json()) });
  });
  afterEach(async () => {
    await platform.stop();
  });

  it('accepts a validly signed RS256 token', async () => {
    const token = await platform.mintIdToken();
    const result = await verifyJwtSignature(token, registrationFor(platform), jwksCache, 120);
    expect(result.ok).toBe(true);
  });

  it('§45 case 11: rejects a token signed by a key not in the platform JWKS (invalid signature)', async () => {
    const impostor = new MockCanvasPlatform();
    await impostor.start();
    try {
      const foreignToken = await impostor.mintIdToken({ iss: platform.issuer });
      const result = await verifyJwtSignature(foreignToken, registrationFor(platform), jwksCache, 120);
      expect(result).toEqual({ ok: false, reason: 'invalid_signature' });
    } finally {
      await impostor.stop();
    }
  });

  it('§45 case 13: rejects a kid that was never published, after one refetch attempt', async () => {
    // Sign with the real, published 'default-kid', then rewrite only the header's `kid` field to
    // a value the platform never published. verifyJwtSignature looks up the kid *before* ever
    // calling jwtVerify, so this deterministically exercises the "still missing after refetch"
    // path without needing a signature that would otherwise fail for an unrelated reason.
    const token = await platform.mintIdToken();
    const tokenWithUnknownKid = withHeaderKid(token, 'never-published');

    const result = await verifyJwtSignature(tokenWithUnknownKid, registrationFor(platform), jwksCache, 120);
    expect(result).toEqual({ ok: false, reason: 'unknown_kid' });
  });

  it('§45 case 14: rejects an expired JWT beyond the clock-skew allowance', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await platform.mintIdToken({ iat: now - 10000, exp: now - 9000 });
    const result = await verifyJwtSignature(token, registrationFor(platform), jwksCache, 120);
    expect(result).toEqual({ ok: false, reason: 'expired_token' });
  });

  it('§45 case 16: rejects a token signed with an algorithm other than RS256', async () => {
    const token = await platform.mintIdToken({}, { alg: 'RS384' });
    const result = await verifyJwtSignature(token, registrationFor(platform), jwksCache, 120);
    expect(result).toEqual({ ok: false, reason: 'unsupported_algorithm' });
  });

  it('§45 case 23: rejects a structurally tampered JWT (header segment is not valid JSON)', async () => {
    const token = await platform.mintIdToken();
    const [, payload, signature] = token.split('.');
    // A deterministic corruption: this base64url segment decodes to the literal text
    // "not valid json", which JSON.parse cannot parse -- decodeProtectedHeader throws reliably,
    // unlike a single-character flip (which can occasionally still decode as valid, different JSON).
    const tamperedHeader = Buffer.from('not valid json').toString('base64url');
    const tamperedToken = `${tamperedHeader}.${payload}.${signature}`;

    const result = await verifyJwtSignature(tamperedToken, registrationFor(platform), jwksCache, 120);
    expect(result).toEqual({ ok: false, reason: 'tampered_token' });
  });
});

describe('validateAudienceAndLifetime', () => {
  const registration = {
    id: 'reg-1',
    institutionId: 'inst-1',
    issuer: 'https://canvas.test',
    clientId: 'client-1',
    oidcAuthEndpoint: 'https://canvas.test/authorize',
    tokenEndpoint: 'https://canvas.test/token',
    tokenAudience: 'https://canvas.test/token',
    platformJwksUri: 'https://canvas.test/jwks',
    enabled: true,
  };

  function payload(overrides: Record<string, unknown> = {}) {
    const now = Math.floor(Date.now() / 1000);
    return { iss: 'https://canvas.test', aud: 'client-1', iat: now, exp: now + 3600, ...overrides };
  }

  it('accepts a payload whose iss/aud/iat all match', () => {
    expect(validateAudienceAndLifetime(payload(), registration, 120)).toEqual({ ok: true });
  });

  it('§45 case 8: rejects a mismatched issuer', () => {
    const result = validateAudienceAndLifetime(payload({ iss: 'https://evil.test' }), registration, 120);
    expect(result).toEqual({ ok: false, reason: 'unknown_issuer' });
  });

  it('§45 case 9: rejects when aud does not contain this registration\'s client_id', () => {
    const result = validateAudienceAndLifetime(payload({ aud: 'someone-elses-client' }), registration, 120);
    expect(result).toEqual({ ok: false, reason: 'audience_mismatch' });
  });

  it('§45 case 10: rejects a multi-value aud with a missing/wrong azp', () => {
    const missingAzp = validateAudienceAndLifetime(payload({ aud: ['client-1', 'another-client'] }), registration, 120);
    expect(missingAzp).toEqual({ ok: false, reason: 'invalid_azp' });

    const wrongAzp = validateAudienceAndLifetime(
      payload({ aud: ['client-1', 'another-client'], azp: 'another-client' }),
      registration,
      120,
    );
    expect(wrongAzp).toEqual({ ok: false, reason: 'invalid_azp' });
  });

  it('accepts a multi-value aud when azp correctly identifies this client', () => {
    const result = validateAudienceAndLifetime(
      payload({ aud: ['client-1', 'another-client'], azp: 'client-1' }),
      registration,
      120,
    );
    expect(result).toEqual({ ok: true });
  });

  it('§45 case 15: rejects a JWT whose iat is implausibly far in the future', () => {
    const now = Math.floor(Date.now() / 1000);
    const result = validateAudienceAndLifetime(payload({ iat: now + 10000 }), registration, 120);
    expect(result).toEqual({ ok: false, reason: 'future_issued_token' });
  });
});
