import { describe, it, expect } from 'vitest';
import { generateKeyPair, exportPKCS8 } from 'jose';
import { loadSigningKeysFromEnv, getActiveSigningKey, type ToolSigningKey } from '../../src/lti/signing-keys.js';

describe('loadSigningKeysFromEnv', () => {
  it('generates a single ephemeral active key when no env var is set', async () => {
    const keys = await loadSigningKeysFromEnv(undefined);
    expect(keys).toHaveLength(1);
    expect(keys[0].status).toBe('active');
    expect(keys[0].publicJwk).not.toHaveProperty('d');
    expect(keys[0].publicJwk.kid).toBe(keys[0].kid);
  });

  it('loads active and previous keys from LTI_TOOL_SIGNING_KEYS_JSON', async () => {
    const { privateKey: activePrivate } = await generateKeyPair('RS256', { modulusLength: 2048, extractable: true });
    const { privateKey: previousPrivate } = await generateKeyPair('RS256', { modulusLength: 2048, extractable: true });
    const json = JSON.stringify([
      { kid: 'active-1', privateKeyPkcs8Pem: await exportPKCS8(activePrivate), status: 'active' },
      { kid: 'previous-1', privateKeyPkcs8Pem: await exportPKCS8(previousPrivate), status: 'previous' },
    ]);

    const keys = await loadSigningKeysFromEnv(json);

    expect(keys.map((k) => k.kid).sort()).toEqual(['active-1', 'previous-1']);
    expect(getActiveSigningKey(keys).kid).toBe('active-1');
    for (const key of keys) {
      expect(key.publicJwk).not.toHaveProperty('d');
      expect(key.publicJwk).not.toHaveProperty('p');
    }
  });

  it('getActiveSigningKey throws when no key is marked active', () => {
    const keys: ToolSigningKey[] = [{ kid: 'x', status: 'previous', privateKey: {} as CryptoKey, publicJwk: {} }];
    expect(() => getActiveSigningKey(keys)).toThrow(/No active tool signing key/);
  });
});
