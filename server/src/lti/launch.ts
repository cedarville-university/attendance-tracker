import type { Database } from '../database/client.js';
import { consumeOidcTransaction, type ConsumedTransaction } from './oidc-transactions.js';
import { findRegistrationById, findDeploymentByBusinessId } from './registrations.js';
import type { LtiRegistration, LtiDeployment } from './types.js';

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
