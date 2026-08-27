import { decodeProtectedHeader, jwtVerify, importJWK, type JWTPayload } from 'jose';
import { createHash } from 'node:crypto';
import type { Database } from '../database/client.js';
import { consumeOidcTransaction, type ConsumedTransaction } from './oidc-transactions.js';
import { findRegistrationById, findDeploymentByBusinessId } from './registrations.js';
import type { LtiRegistration, LtiDeployment } from './types.js';
import type { JwksCache } from './jwks-cache.js';
import { validateLtiClaims, type ValidatedLtiClaims } from './claims.js';
import { authorizeInstructorRole } from './roles.js';

export type LaunchFailureReason =
  | 'missing_state'
  | 'unknown_state'
  | 'expired_state'
  | 'reused_state'
  | 'nonce_mismatch'
  | 'nonce_replay'
  | 'unknown_issuer'
  | 'audience_mismatch'
  | 'invalid_azp'
  | 'invalid_signature'
  | 'unknown_kid'
  | 'unsupported_algorithm'
  | 'expired_token'
  | 'future_issued_token'
  | 'wrong_deployment'
  | 'wrong_version'
  | 'wrong_message_type'
  | 'missing_context'
  | 'missing_roles'
  | 'learner_only_role'
  | 'tampered_token';
// NOTE on 'nonce_replay' (§45 case 7): nonce and state are minted and consumed together as a
// single OIDC transaction row (spec §12.2 and §13.7), so nonce single-use is enforced by the exact
// same atomic UPDATE that enforces state single-use. That makes case 7 split into two concrete
// attacks, and neither of them can ever produce a distinct 'nonce_replay' reason:
//   (a) replaying a captured (state, id_token) PAIR -- caught as 'reused_state' in
//       resolveTransactionContext, before the nonce is even re-compared;
//   (b) pairing an OLD captured nonce with a FRESH state (the genuinely distinct threat) --
//       the fresh transaction row has a different nonce_hash, so validateNonceClaimsAndRole
//       rejects it as 'nonce_mismatch'.
// Task 23 has a test for each. This literal is kept in the union purely so a reader grepping for
// spec §45 case 7 lands on this explanation; no code path returns it, and no test expects it.

export interface TransactionContext {
  transaction: ConsumedTransaction;
  registration: LtiRegistration;
  deployment: LtiDeployment;
}

export type ResolveTransactionResult =
  | { ok: true; context: TransactionContext }
  | { ok: false; reason: LaunchFailureReason };

export async function resolveTransactionContext(db: Database, state: string): Promise<ResolveTransactionResult> {
  const consumed = await consumeOidcTransaction(db, state);
  if (!consumed.ok) {
    return { ok: false, reason: consumed.reason };
  }

  const registration = await findRegistrationById(db, consumed.transaction.registrationId);
  if (!registration || !registration.enabled) {
    return { ok: false, reason: 'unknown_issuer' };
  }

  const deployment = await findDeploymentByBusinessId(db, registration.id, consumed.transaction.deploymentId);
  if (!deployment || !deployment.enabled) {
    return { ok: false, reason: 'wrong_deployment' };
  }

  return { ok: true, context: { transaction: consumed.transaction, registration, deployment } };
}

export type VerifyJwtSignatureResult = { ok: true; payload: JWTPayload } | { ok: false; reason: LaunchFailureReason };

export async function verifyJwtSignature(
  idToken: string,
  registration: LtiRegistration,
  jwksCache: JwksCache,
  clockSkewSeconds: number,
): Promise<VerifyJwtSignatureResult> {
  let header;
  try {
    header = decodeProtectedHeader(idToken);
  } catch {
    return { ok: false, reason: 'tampered_token' };
  }

  if (header.alg !== 'RS256') {
    return { ok: false, reason: 'unsupported_algorithm' };
  }
  if (!header.kid) {
    return { ok: false, reason: 'unknown_kid' };
  }

  const jwk = await jwksCache.getKey(registration.id, registration.platformJwksUri, header.kid);
  if (!jwk) {
    return { ok: false, reason: 'unknown_kid' };
  }

  let publicKey;
  try {
    publicKey = await importJWK(jwk, 'RS256');
  } catch {
    return { ok: false, reason: 'unknown_kid' };
  }

  try {
    const verified = await jwtVerify(idToken, publicKey, {
      algorithms: ['RS256'],
      clockTolerance: clockSkewSeconds,
    });
    return { ok: true, payload: verified.payload };
  } catch (err) {
    const code = (err as { code?: string; claim?: string })?.code;
    if (code === 'ERR_JWT_EXPIRED') {
      return { ok: false, reason: 'expired_token' };
    }
    if (code === 'ERR_JWT_CLAIM_VALIDATION_FAILED' && (err as { claim?: string }).claim === 'nbf') {
      return { ok: false, reason: 'future_issued_token' };
    }
    return { ok: false, reason: 'invalid_signature' };
  }
}

export type ValidateAudienceResult = { ok: true } | { ok: false; reason: LaunchFailureReason };

export function validateAudienceAndLifetime(
  payload: JWTPayload,
  registration: LtiRegistration,
  clockSkewSeconds: number,
): ValidateAudienceResult {
  if (payload.iss !== registration.issuer) {
    return { ok: false, reason: 'unknown_issuer' };
  }

  const audiences = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : [];
  if (!audiences.includes(registration.clientId)) {
    return { ok: false, reason: 'audience_mismatch' };
  }
  if (audiences.length > 1 && (typeof payload.azp !== 'string' || payload.azp !== registration.clientId)) {
    return { ok: false, reason: 'invalid_azp' };
  }

  // verifyJwtSignature's jwtVerify call already rejected exp/nbf outside clockSkewSeconds; iat is
  // not validated by jose at all, so an implausibly-future-issued token is only caught here.
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.iat !== 'number' || payload.iat - clockSkewSeconds > now) {
    return { ok: false, reason: 'future_issued_token' };
  }

  return { ok: true };
}

function hashToken(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export interface NonceClaimsRoleResult {
  claims: ValidatedLtiClaims;
  roles: string[];
}

export type ValidateNonceClaimsAndRoleResult =
  | { ok: true; result: NonceClaimsRoleResult }
  | { ok: false; reason: LaunchFailureReason };

export function validateNonceClaimsAndRole(
  payload: JWTPayload,
  transaction: ConsumedTransaction,
): ValidateNonceClaimsAndRoleResult {
  if (typeof payload.nonce !== 'string' || hashToken(payload.nonce) !== transaction.nonceHash) {
    return { ok: false, reason: 'nonce_mismatch' };
  }

  const claimsResult = validateLtiClaims(payload);
  if (!claimsResult.ok) {
    return { ok: false, reason: claimsResult.reason };
  }
  const claims = claimsResult.claims;

  if (claims['https://purl.imsglobal.org/spec/lti/claim/deployment_id'] !== transaction.deploymentId) {
    return { ok: false, reason: 'wrong_deployment' };
  }

  const roles = claims['https://purl.imsglobal.org/spec/lti/claim/roles'];
  if (!authorizeInstructorRole(roles)) {
    return { ok: false, reason: 'learner_only_role' };
  }

  return { ok: true, result: { claims, roles } };
}
