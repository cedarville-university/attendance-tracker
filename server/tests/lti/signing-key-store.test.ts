import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { exportPKCS8, generateKeyPair } from 'jose';
import { getTestDb, resetDb, closeTestDb } from '../support/db.js';
import { toolSigningKeys } from '../../src/database/schema.js';
import { loadSigningKeys, rotateSigningKey, SigningKeyProvider } from '../../src/lti/signing-key-store.js';

const { db } = getTestDb();
afterAll(() => closeTestDb());
beforeEach(async () => {
  await resetDb();
});

async function makePkcs8Pem(): Promise<string> {
  const { privateKey } = await generateKeyPair('RS256', { modulusLength: 2048, extractable: true });
  return exportPKCS8(privateKey);
}

describe('loadSigningKeys', () => {
  it('env JSON wins over the DB', async () => {
    // A DB row exists, but env config takes precedence.
    await db.insert(toolSigningKeys).values({
      kid: 'db-kid',
      status: 'active',
      privateKeyPkcs8Pem: await makePkcs8Pem(),
      publicJwk: { kid: 'db-kid' },
    });
    const envJson = JSON.stringify([{ kid: 'env-kid', status: 'active', privateKeyPkcs8Pem: await makePkcs8Pem() }]);

    const keys = await loadSigningKeys(db, envJson);
    expect(keys.map((k) => k.kid)).toEqual(['env-kid']);
  });

  it('loads and imports existing DB rows', async () => {
    const pem = await makePkcs8Pem();
    await db.insert(toolSigningKeys).values({ kid: 'stored', status: 'active', privateKeyPkcs8Pem: pem, publicJwk: {} });

    const keys = await loadSigningKeys(db, undefined);
    expect(keys).toHaveLength(1);
    expect(keys[0].kid).toBe('stored');
    expect(keys[0].publicJwk).toMatchObject({ kty: 'RSA', kid: 'stored', use: 'sig', alg: 'RS256' });
  });

  it('generates AND persists a key on an empty DB, and reuses it on the next load', async () => {
    const first = await loadSigningKeys(db, undefined);
    expect(first).toHaveLength(1);

    const rows = await db.select().from(toolSigningKeys);
    expect(rows).toHaveLength(1);
    expect(rows[0].kid).toBe(first[0].kid);
    expect(rows[0].status).toBe('active');

    const second = await loadSigningKeys(db, undefined);
    expect(second[0].kid).toBe(first[0].kid); // stable across "restarts"
  });
});

describe('rotateSigningKey', () => {
  it('demotes the old active to previous and leaves exactly one active', async () => {
    const before = await loadSigningKeys(db, undefined);
    const oldKid = before[0].kid;

    const fresh = await rotateSigningKey(db);
    expect(fresh.kid).not.toBe(oldKid);

    const rows = await db.select().from(toolSigningKeys);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.status === 'active')).toHaveLength(1);
    expect(rows.find((r) => r.kid === oldKid)!.status).toBe('previous');
    expect(rows.find((r) => r.kid === fresh.kid)!.status).toBe('active');
  });
});

describe('SigningKeyProvider', () => {
  it('reload() picks up a rotation', async () => {
    const provider = new SigningKeyProvider(await loadSigningKeys(db, undefined));
    const originalKid = provider.getActive().kid;

    await rotateSigningKey(db);
    expect(provider.getActive().kid).toBe(originalKid); // not yet reloaded

    await provider.reload(db, undefined);
    expect(provider.getActive().kid).not.toBe(originalKid);
    expect(provider.list().some((k) => k.kid === originalKid && k.status === 'previous')).toBe(true);
  });
});
