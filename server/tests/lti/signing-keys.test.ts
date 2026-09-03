import { describe, it, expect } from 'vitest';
import { generateKeyPair, exportPKCS8 } from 'jose';
import { loadSigningKeysFromEnv, getActiveSigningKey, type ToolSigningKey } from '../../src/lti/signing-keys.js';

const PRIVATE_JWK_FIELDS = ['d', 'p', 'q', 'dp', 'dq', 'qi'] as const;

describe('loadSigningKeysFromEnv', () => {
  it('generates a single ephemeral active key when no env var is set', async () => {
    const keys = await loadSigningKeysFromEnv(undefined);
    expect(keys).toHaveLength(1);
    expect(keys[0].status).toBe('active');
    for (const field of PRIVATE_JWK_FIELDS) {
      expect(keys[0].publicJwk).not.toHaveProperty(field);
    }
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
      for (const field of PRIVATE_JWK_FIELDS) {
        expect(key.publicJwk).not.toHaveProperty(field);
      }
    }
  });

  it('getActiveSigningKey throws when no key is marked active', () => {
    const keys: ToolSigningKey[] = [{ kid: 'x', status: 'previous', privateKey: {} as CryptoKey, publicJwk: {} }];
    expect(() => getActiveSigningKey(keys)).toThrow(/No active tool signing key/);
  });

  it('throws a fixed message for malformed JSON without echoing the input', async () => {
    // The plausible operator error: pasting raw PEM key material into the env var without
    // JSON-wrapping it. V8's JSON.parse error would otherwise embed a fragment of that key
    // material (e.g. `Unexpected token 'M', "MIIEvQIBAD"... is not valid JSON`).
    const rawPem = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASSUPERSECRETVALUE1234567890';

    await expect(loadSigningKeysFromEnv(rawPem)).rejects.toThrow('Malformed LTI_TOOL_SIGNING_KEYS_JSON');

    try {
      await loadSigningKeysFromEnv(rawPem);
      expect.unreachable();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(rawPem);
      expect(message).not.toContain('MIIEvQIBAD');
      expect(error instanceof Error ? error.cause : undefined).toBeUndefined();
    }
  });

  it('rejects an entry with an invalid status value', async () => {
    const { privateKey } = await generateKeyPair('RS256', { modulusLength: 2048, extractable: true });
    const json = JSON.stringify([
      { kid: 'active-1', privateKeyPkcs8Pem: await exportPKCS8(privateKey), status: 'Active' },
    ]);

    await expect(loadSigningKeysFromEnv(json)).rejects.toThrow(/Invalid LTI_TOOL_SIGNING_KEYS_JSON/);
  });

  it('rejects an entry missing kid', async () => {
    const { privateKey } = await generateKeyPair('RS256', { modulusLength: 2048, extractable: true });
    const json = JSON.stringify([{ privateKeyPkcs8Pem: await exportPKCS8(privateKey), status: 'active' }]);

    await expect(loadSigningKeysFromEnv(json)).rejects.toThrow(/Invalid LTI_TOOL_SIGNING_KEYS_JSON/);
  });

  it('rejects multiple entries marked active', async () => {
    const { privateKey: first } = await generateKeyPair('RS256', { modulusLength: 2048, extractable: true });
    const { privateKey: second } = await generateKeyPair('RS256', { modulusLength: 2048, extractable: true });
    const json = JSON.stringify([
      { kid: 'active-1', privateKeyPkcs8Pem: await exportPKCS8(first), status: 'active' },
      { kid: 'active-2', privateKeyPkcs8Pem: await exportPKCS8(second), status: 'active' },
    ]);

    await expect(loadSigningKeysFromEnv(json)).rejects.toThrow(/at most one entry with status/);
  });
});
