// server/src/lti/signing-key-store.ts
//
// DB-backed loader for the tool's own LTI signing keys, with a small in-memory provider so a
// rotation from the admin setup page takes effect without a server restart.
//
// Precedence (see `loadSigningKeys`):
//   1. LTI_TOOL_SIGNING_KEYS_JSON present  -> env config wins (prod path; unchanged behaviour).
//   2. rows in tool_signing_keys           -> import each stored PKCS#8 PEM.
//   3. empty table                         -> generate one key, PERSIST it as `active`, return it.
//      Restarts then reuse the same `kid`, so `/lti/jwks` and the `client_assertion` `kid` are
//      stable in dev without any env config.

import { asc, eq } from 'drizzle-orm';
import type { Database } from '../database/client.js';
import { toolSigningKeys } from '../database/schema.js';
import {
  type ToolSigningKey,
  exportSigningKeyPkcs8Pem,
  generateEphemeralSigningKey,
  getActiveSigningKey,
  importSigningKeyFromPkcs8,
  loadSigningKeysFromEnv,
} from './signing-keys.js';

async function loadFromDb(db: Database): Promise<ToolSigningKey[]> {
  const rows = await db.select().from(toolSigningKeys).orderBy(asc(toolSigningKeys.createdAt));
  return Promise.all(rows.map((row) => importSigningKeyFromPkcs8(row.kid, row.privateKeyPkcs8Pem, row.status)));
}

async function persistKey(db: Database, key: ToolSigningKey): Promise<void> {
  await db.insert(toolSigningKeys).values({
    kid: key.kid,
    status: key.status,
    privateKeyPkcs8Pem: await exportSigningKeyPkcs8Pem(key),
    publicJwk: key.publicJwk,
  });
}

export async function loadSigningKeys(db: Database, envJson: string | undefined): Promise<ToolSigningKey[]> {
  if (envJson) {
    return loadSigningKeysFromEnv(envJson);
  }
  const fromDb = await loadFromDb(db);
  if (fromDb.length > 0) {
    return fromDb;
  }
  const generated = await generateEphemeralSigningKey();
  await persistKey(db, generated);
  return [generated];
}

/**
 * Demotes the current `active` key to `previous` and inserts a fresh `active` one, in a
 * transaction. The partial unique index (`tool_signing_keys_one_active`) guarantees the
 * demote-then-insert order is enforced even under a concurrent call.
 */
export async function rotateSigningKey(db: Database): Promise<ToolSigningKey> {
  const fresh = await generateEphemeralSigningKey();
  const freshPem = await exportSigningKeyPkcs8Pem(fresh);
  await db.transaction(async (tx) => {
    await tx
      .update(toolSigningKeys)
      .set({ status: 'previous', updatedAt: new Date() })
      .where(eq(toolSigningKeys.status, 'active'));
    await tx.insert(toolSigningKeys).values({
      kid: fresh.kid,
      status: 'active',
      privateKeyPkcs8Pem: freshPem,
      publicJwk: fresh.publicJwk,
    });
  });
  return fresh;
}

/**
 * Holds the current ToolSigningKey[] in memory. Route registrars read `getActive()` / `list()`
 * at request time, so `reload()` after a rotation is picked up without a restart.
 */
export class SigningKeyProvider {
  #keys: ToolSigningKey[];

  constructor(keys: ToolSigningKey[]) {
    this.#keys = keys;
  }

  list(): ToolSigningKey[] {
    return this.#keys;
  }

  getActive(): ToolSigningKey {
    return getActiveSigningKey(this.#keys);
  }

  async reload(db: Database, envJson: string | undefined): Promise<void> {
    this.#keys = await loadSigningKeys(db, envJson);
  }
}
