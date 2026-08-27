import { describe, it, expect } from 'vitest';
import { buildJwksResponse } from '../../src/lti/jwks-route.js';
import { loadSigningKeysFromEnv } from '../../src/lti/signing-keys.js';

describe('buildJwksResponse', () => {
  it('exposes only public fields, never private key material', async () => {
    const keys = await loadSigningKeysFromEnv(undefined);
    const response = buildJwksResponse(keys);

    expect(response.keys).toHaveLength(1);
    const jwk = response.keys[0];
    expect(Object.keys(jwk).sort()).toEqual(['alg', 'e', 'kid', 'kty', 'n', 'use'].sort());
    expect(jwk).not.toHaveProperty('d');
    expect(jwk).not.toHaveProperty('p');
    expect(jwk).not.toHaveProperty('q');
  });
});
