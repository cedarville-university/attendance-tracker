// Test helpers for the signing-key provider that route registrars now take.

import { SigningKeyProvider } from '../../src/lti/signing-key-store.js';
import { loadSigningKeysFromEnv, type ToolSigningKey } from '../../src/lti/signing-keys.js';

/** A provider backed by one real ephemeral RS256 key (public JWK + usable private key). */
export async function testSigningKeyProvider(): Promise<SigningKeyProvider> {
  return new SigningKeyProvider(await loadSigningKeysFromEnv(undefined));
}

/**
 * A provider whose `getActive()` returns a typed stub — for tests where the roster/AGS helper that
 * would use the key is itself mocked, so the key is never actually exercised.
 */
export function stubSigningKeyProvider(): SigningKeyProvider {
  return new SigningKeyProvider([{ status: 'active' } as ToolSigningKey]);
}
