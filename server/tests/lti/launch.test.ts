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

import { createHash } from 'node:crypto';
import { validateNonceClaimsAndRole } from '../../src/lti/launch.js';
import type { ConsumedTransaction } from '../../src/lti/oidc-transactions.js';

function hashForTest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function transactionFor(nonce: string, deploymentId = 'deploy-1'): ConsumedTransaction {
  return {
    id: 'txn-1',
    registrationId: 'reg-1',
    deploymentId,
    nonceHash: hashForTest(nonce),
    targetLinkUri: 'https://app.test/index.html',
  };
}

function claimsPayload(overrides: Record<string, unknown> = {}) {
  return {
    sub: 'user-1',
    nonce: 'real-nonce',
    'https://purl.imsglobal.org/spec/lti/claim/version': '1.3.0',
    'https://purl.imsglobal.org/spec/lti/claim/message_type': 'LtiResourceLinkRequest',
    'https://purl.imsglobal.org/spec/lti/claim/deployment_id': 'deploy-1',
    'https://purl.imsglobal.org/spec/lti/claim/context': { id: 'course-1' },
    'https://purl.imsglobal.org/spec/lti/claim/roles': ['http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor'],
    ...overrides,
  };
}

describe('validateNonceClaimsAndRole', () => {
  it('accepts a matching nonce with valid claims and an instructor role', () => {
    const result = validateNonceClaimsAndRole(claimsPayload(), transactionFor('real-nonce'));
    expect(result.ok).toBe(true);
  });

  it("§45 case 6: rejects a nonce that does not match the transaction's stored nonce", () => {
    const result = validateNonceClaimsAndRole(claimsPayload({ nonce: 'wrong-nonce' }), transactionFor('real-nonce'));
    expect(result).toEqual({ ok: false, reason: 'nonce_mismatch' });
  });

  it("§45 case 17 (claim-level variant): rejects when the claimed deployment_id doesn't match the transaction's", () => {
    const result = validateNonceClaimsAndRole(
      claimsPayload({ 'https://purl.imsglobal.org/spec/lti/claim/deployment_id': 'other-deploy' }),
      transactionFor('real-nonce', 'deploy-1'),
    );
    expect(result).toEqual({ ok: false, reason: 'wrong_deployment' });
  });

  it('§45 case 20: propagates missing_context from claims validation', () => {
    const { 'https://purl.imsglobal.org/spec/lti/claim/context': _context, ...withoutContext } = claimsPayload();
    const result = validateNonceClaimsAndRole(withoutContext, transactionFor('real-nonce'));
    expect(result).toEqual({ ok: false, reason: 'missing_context' });
  });

  it('§45 case 22: rejects a learner-only role', () => {
    const result = validateNonceClaimsAndRole(
      claimsPayload({
        'https://purl.imsglobal.org/spec/lti/claim/roles': ['http://purl.imsglobal.org/vocab/lis/v2/membership#Learner'],
      }),
      transactionFor('real-nonce'),
    );
    expect(result).toEqual({ ok: false, reason: 'learner_only_role' });
  });
});

// New imports needed for this block (everything else -- eq, ltiDeployments, getTestDb, resetDb,
// seedInstitutionAndRegistration, MockCanvasPlatform, createOidcTransaction, JwksCache --
// reuses imports already added in Tasks 19-22):
import { appSessions } from '../../src/database/schema.js';
import { consumeOidcTransaction } from '../../src/lti/oidc-transactions.js';
import {
  verifyLaunch,
  type VerifyLaunchDeps,
  type VerifyLaunchInput,
  type LaunchFailureReason,
} from '../../src/lti/launch.js';

describe('verifyLaunch (full orchestration)', () => {
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

  async function countSessions(): Promise<number> {
    const { db } = getTestDb();
    return (await db.select().from(appSessions)).length;
  }

  async function setUpValidTransaction(targetLinkUri = 'https://app.test/index.html') {
    const { db } = getTestDb();
    const seeded = await seedInstitutionAndRegistration(db, platform);
    const created = await createOidcTransaction(db, {
      registrationId: seeded.registrationId,
      deploymentId: seeded.deploymentId,
      targetLinkUri,
      ttlSeconds: 300,
    });
    return { seeded, created };
  }

  function deps(): VerifyLaunchDeps {
    return { db: getTestDb().db, jwksCache, clockSkewSeconds: 120, sessionTtlHours: 8 };
  }

  it('§45 case 1: a fully valid launch succeeds and creates exactly one session', async () => {
    const { created } = await setUpValidTransaction();
    const idToken = await platform.mintIdToken({ nonce: created.nonce });

    const result = await verifyLaunch({ state: created.state, idToken }, deps());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.roles).toContain('http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor');
      expect(result.courseId).toBeTruthy();
      // The transaction's stored target_link_uri survives out of verifyLaunch so Task 24's route
      // can redirect to it instead of hardcoding one page (spec §12.1/§14).
      expect(result.targetLinkUri).toBe('https://app.test/index.html');
    }
    expect(await countSessions()).toBe(1);
  });

  it('returns the transaction\'s own target_link_uri, not a hardcoded default', async () => {
    const { created } = await setUpValidTransaction('https://app.test/scanner.html');
    const idToken = await platform.mintIdToken({ nonce: created.nonce });

    const result = await verifyLaunch({ state: created.state, idToken }, deps());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.targetLinkUri).toBe('https://app.test/scanner.html');
    }
  });

  it('§45 case 2: rejects a request missing state or id_token, creating no session', async () => {
    expect(await verifyLaunch({ state: undefined, idToken: 'anything' }, deps())).toEqual({ ok: false, reason: 'missing_state' });
    expect(await verifyLaunch({ state: 'anything', idToken: undefined }, deps())).toEqual({ ok: false, reason: 'missing_state' });
    expect(await countSessions()).toBe(0);
  });

  it('§45 case 7 (pair replay): a full replay of a captured (state, id_token) pair is rejected on the second attempt, creating no second session', async () => {
    const { created } = await setUpValidTransaction();
    const idToken = await platform.mintIdToken({ nonce: created.nonce });

    const first = await verifyLaunch({ state: created.state, idToken }, deps());
    expect(first.ok).toBe(true);

    const second = await verifyLaunch({ state: created.state, idToken }, deps());
    expect(second).toEqual({ ok: false, reason: 'reused_state' });
    expect(await countSessions()).toBe(1); // still just the one session from the first (legitimate) attempt
  });

  it('§45 case 7 (stale nonce on a fresh state): an old captured nonce paired with a brand-new state is rejected, creating no session', async () => {
    const { db } = getTestDb();
    // This is the variant a pair-replay test cannot reach: the attacker starts a *legitimate* new
    // login (so `state` is fresh and unconsumed) but presents an id_token minted for an earlier
    // transaction's nonce. state single-use does not catch it; the nonce comparison must.
    const { seeded, created: stale } = await setUpValidTransaction();
    const staleNonceToken = await platform.mintIdToken({ nonce: stale.nonce });

    const fresh = await createOidcTransaction(db, {
      registrationId: seeded.registrationId,
      deploymentId: seeded.deploymentId,
      targetLinkUri: 'https://app.test/index.html',
      ttlSeconds: 300,
    });

    const result = await verifyLaunch({ state: fresh.state, idToken: staleNonceToken }, deps());

    expect(result).toEqual({ ok: false, reason: 'nonce_mismatch' });
    expect(await countSessions()).toBe(0);
  });

  it('every §45 failure case reachable through verifyLaunch rejects end-to-end with the documented reason and creates no session', async () => {
    // A second platform with its own key material, used only by the invalid_signature scenario.
    const impostor = new MockCanvasPlatform();
    await impostor.start();

    try {
      const scenarios: Array<{
        name: string;
        expectedReason: LaunchFailureReason;
        build: () => Promise<VerifyLaunchInput>;
      }> = [
        {
          name: 'case 3: unknown_state',
          expectedReason: 'unknown_state',
          build: async () => ({ state: 'never-issued-state-value', idToken: await platform.mintIdToken() }),
        },
        {
          name: 'case 4: expired_state',
          expectedReason: 'expired_state',
          build: async () => {
            const { db } = getTestDb();
            const seeded = await seedInstitutionAndRegistration(db, platform);
            const created = await createOidcTransaction(db, {
              registrationId: seeded.registrationId,
              deploymentId: seeded.deploymentId,
              targetLinkUri: 'https://app.test/index.html',
              ttlSeconds: -1,
            });
            return { state: created.state, idToken: await platform.mintIdToken({ nonce: created.nonce }) };
          },
        },
        {
          name: 'case 5: reused_state',
          expectedReason: 'reused_state',
          build: async () => {
            const { db } = getTestDb();
            const { created } = await setUpValidTransaction();
            const idToken = await platform.mintIdToken({ nonce: created.nonce });
            await consumeOidcTransaction(db, created.state); // burn it outside verifyLaunch
            return { state: created.state, idToken };
          },
        },
        {
          name: 'case 6: nonce_mismatch',
          expectedReason: 'nonce_mismatch',
          build: async () => {
            const { created } = await setUpValidTransaction();
            return { state: created.state, idToken: await platform.mintIdToken({ nonce: 'not-the-issued-nonce' }) };
          },
        },
        {
          name: 'case 8: unknown_issuer',
          expectedReason: 'unknown_issuer',
          build: async () => {
            const { created } = await setUpValidTransaction();
            // Signed by the registration's real platform key, so the signature check passes and the
            // iss comparison is genuinely what rejects it.
            return { state: created.state, idToken: await platform.mintIdToken({ nonce: created.nonce, iss: 'https://evil.test' }) };
          },
        },
        {
          name: 'case 9: audience_mismatch',
          expectedReason: 'audience_mismatch',
          build: async () => {
            const { created } = await setUpValidTransaction();
            return { state: created.state, idToken: await platform.mintIdToken({ nonce: created.nonce, aud: 'someone-else' }) };
          },
        },
        {
          name: 'case 10: invalid_azp',
          expectedReason: 'invalid_azp',
          build: async () => {
            const { created } = await setUpValidTransaction();
            return {
              state: created.state,
              idToken: await platform.mintIdToken({ nonce: created.nonce, aud: ['mock-client-id', 'another-client'] }),
            };
          },
        },
        {
          name: 'case 11: invalid_signature',
          expectedReason: 'invalid_signature',
          build: async () => {
            const { created } = await setUpValidTransaction();
            // The impostor publishes its own 'default-kid', so the kid resolves against the real
            // platform's JWKS and the RSA verification -- not the kid lookup -- is what fails.
            return { state: created.state, idToken: await impostor.mintIdToken({ nonce: created.nonce }) };
          },
        },
        {
          name: 'case 13: unknown_kid (still missing after one JWKS refetch)',
          expectedReason: 'unknown_kid',
          build: async () => {
            const { created } = await setUpValidTransaction();
            const idToken = await platform.mintIdToken({ nonce: created.nonce });
            return { state: created.state, idToken: withHeaderKid(idToken, 'never-published') };
          },
        },
        {
          name: 'case 14: expired_token',
          expectedReason: 'expired_token',
          build: async () => {
            const { created } = await setUpValidTransaction();
            const now = Math.floor(Date.now() / 1000);
            return {
              state: created.state,
              idToken: await platform.mintIdToken({ nonce: created.nonce, iat: now - 10000, exp: now - 9000 }),
            };
          },
        },
        {
          name: 'case 15: future_issued_token',
          expectedReason: 'future_issued_token',
          build: async () => {
            const { created } = await setUpValidTransaction();
            const now = Math.floor(Date.now() / 1000);
            return { state: created.state, idToken: await platform.mintIdToken({ nonce: created.nonce, iat: now + 10000 }) };
          },
        },
        {
          name: 'case 16: unsupported_algorithm',
          expectedReason: 'unsupported_algorithm',
          build: async () => {
            const { created } = await setUpValidTransaction();
            return { state: created.state, idToken: await platform.mintIdToken({ nonce: created.nonce }, { alg: 'RS384' }) };
          },
        },
        {
          name: 'case 17a: wrong_deployment (deployment disabled between login and launch)',
          expectedReason: 'wrong_deployment',
          build: async () => {
            const { db } = getTestDb();
            const { seeded, created } = await setUpValidTransaction();
            const idToken = await platform.mintIdToken({ nonce: created.nonce });
            await db.update(ltiDeployments).set({ enabled: false }).where(eq(ltiDeployments.id, seeded.deploymentRowId));
            return { state: created.state, idToken };
          },
        },
        {
          name: 'case 17b: wrong_deployment (deployment_id claim does not match the transaction)',
          expectedReason: 'wrong_deployment',
          build: async () => {
            const { created } = await setUpValidTransaction();
            return {
              state: created.state,
              idToken: await platform.mintIdToken({ nonce: created.nonce, deploymentId: 'some-other-deployment' }),
            };
          },
        },
        {
          name: 'case 18: wrong_version',
          expectedReason: 'wrong_version',
          build: async () => {
            const { created } = await setUpValidTransaction();
            return { state: created.state, idToken: await platform.mintIdToken({ nonce: created.nonce, version: '1.1.0' }) };
          },
        },
        {
          name: 'case 19: wrong_message_type',
          expectedReason: 'wrong_message_type',
          build: async () => {
            const { created } = await setUpValidTransaction();
            return {
              state: created.state,
              idToken: await platform.mintIdToken({ nonce: created.nonce, messageType: 'LtiDeepLinkingRequest' }),
            };
          },
        },
        {
          name: 'case 20: missing_context',
          expectedReason: 'missing_context',
          build: async () => {
            const { created } = await setUpValidTransaction();
            return { state: created.state, idToken: await platform.mintIdToken({ nonce: created.nonce, contextId: null }) };
          },
        },
        {
          name: 'case 21: missing_roles',
          expectedReason: 'missing_roles',
          build: async () => {
            const { created } = await setUpValidTransaction();
            return { state: created.state, idToken: await platform.mintIdToken({ nonce: created.nonce, roles: null }) };
          },
        },
        {
          name: 'case 22: learner_only_role',
          expectedReason: 'learner_only_role',
          build: async () => {
            const { created } = await setUpValidTransaction();
            return {
              state: created.state,
              idToken: await platform.mintIdToken({
                nonce: created.nonce,
                roles: ['http://purl.imsglobal.org/vocab/lis/v2/membership#Learner'],
              }),
            };
          },
        },
        {
          name: 'case 23: tampered_token',
          expectedReason: 'tampered_token',
          build: async () => {
            const { created } = await setUpValidTransaction();
            const idToken = await platform.mintIdToken({ nonce: created.nonce });
            const [, payloadSegment, signatureSegment] = idToken.split('.');
            // Same deterministic corruption as Task 20's unit test: a header segment that decodes
            // to text JSON.parse cannot parse, so decodeProtectedHeader throws reliably.
            const tamperedHeader = Buffer.from('not valid json').toString('base64url');
            return { state: created.state, idToken: `${tamperedHeader}.${payloadSegment}.${signatureSegment}` };
          },
        },
      ];

      for (const scenario of scenarios) {
        await resetDb();
        const input = await scenario.build();
        const result = await verifyLaunch(input, deps());
        expect(result, scenario.name).toEqual({ ok: false, reason: scenario.expectedReason });
        expect(await countSessions(), scenario.name).toBe(0);
      }
    } finally {
      await impostor.stop();
    }
  });
});
