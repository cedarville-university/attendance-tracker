import { randomBytes, createHash } from 'node:crypto';
import { and, eq, isNull, gt, sql } from 'drizzle-orm';
import type { Database } from '../database/client.js';
import { oidcTransactions } from '../database/schema.js';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface CreateOidcTransactionParams {
  registrationId: string;
  deploymentId: string;
  targetLinkUri: string;
  ttlSeconds: number;
}

export interface CreatedTransaction {
  state: string;
  nonce: string;
  transactionId: string;
}

export async function createOidcTransaction(db: Database, params: CreateOidcTransactionParams): Promise<CreatedTransaction> {
  const state = randomBytes(32).toString('base64url');
  const nonce = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + params.ttlSeconds * 1000);

  const [row] = await db
    .insert(oidcTransactions)
    .values({
      registrationId: params.registrationId,
      deploymentId: params.deploymentId,
      stateHash: hashToken(state),
      nonceHash: hashToken(nonce),
      targetLinkUri: params.targetLinkUri,
      expiresAt,
    })
    .returning();

  return { state, nonce, transactionId: row.id };
}

export interface ConsumedTransaction {
  id: string;
  registrationId: string;
  deploymentId: string;
  nonceHash: string;
  targetLinkUri: string;
}

export type ConsumeTransactionResult =
  | { ok: true; transaction: ConsumedTransaction }
  | { ok: false; reason: 'unknown_state' | 'expired_state' | 'reused_state' };

export async function consumeOidcTransaction(db: Database, state: string): Promise<ConsumeTransactionResult> {
  const stateHash = hashToken(state);

  const existing = await db.select().from(oidcTransactions).where(eq(oidcTransactions.stateHash, stateHash)).limit(1);
  const row = existing[0];
  if (!row) {
    return { ok: false, reason: 'unknown_state' };
  }
  if (row.consumedAt !== null) {
    return { ok: false, reason: 'reused_state' };
  }
  if (row.expiresAt.getTime() <= Date.now()) {
    return { ok: false, reason: 'expired_state' };
  }

  // Atomic single-use consume: closes the replay race in one round trip. The pre-checks above
  // exist only to classify the *common* failure reason precisely; this UPDATE is the actual guard.
  const updated = await db
    .update(oidcTransactions)
    .set({ consumedAt: sql`now()` })
    .where(and(eq(oidcTransactions.stateHash, stateHash), isNull(oidcTransactions.consumedAt), gt(oidcTransactions.expiresAt, new Date())))
    .returning();

  const winner = updated[0];
  if (!winner) {
    return { ok: false, reason: 'reused_state' };
  }

  return {
    ok: true,
    transaction: {
      id: winner.id,
      registrationId: winner.registrationId,
      deploymentId: winner.deploymentId,
      nonceHash: winner.nonceHash,
      targetLinkUri: winner.targetLinkUri,
    },
  };
}
