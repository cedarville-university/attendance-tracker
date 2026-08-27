import { generateKeyPair, exportJWK, importPKCS8 } from 'jose';
import { randomUUID } from 'node:crypto';

export interface ToolSigningKey {
  kid: string;
  status: 'active' | 'previous';
  privateKey: CryptoKey;
  publicJwk: Record<string, unknown>;
}

interface RawSigningKeyConfig {
  kid: string;
  privateKeyPkcs8Pem: string;
  status: 'active' | 'previous';
}

async function toPublicJwk(privateKey: CryptoKey, kid: string): Promise<Record<string, unknown>> {
  const full = (await exportJWK(privateKey)) as { kty: string; n: string; e: string };
  return { kty: full.kty, n: full.n, e: full.e, kid, use: 'sig', alg: 'RS256' };
}

async function generateEphemeralSigningKey(): Promise<ToolSigningKey> {
  const { privateKey } = await generateKeyPair('RS256', { modulusLength: 2048, extractable: true });
  const kid = randomUUID();
  return { kid, status: 'active', privateKey, publicJwk: await toPublicJwk(privateKey, kid) };
}

export async function loadSigningKeysFromEnv(json: string | undefined): Promise<ToolSigningKey[]> {
  if (!json) {
    return [await generateEphemeralSigningKey()];
  }

  const raw = JSON.parse(json) as RawSigningKeyConfig[];
  return Promise.all(
    raw.map(async (entry) => {
      // `extractable: true` is REQUIRED: importPKCS8 defaults to extractable:false, and
      // toPublicJwk() below calls exportJWK() on this key to derive the public JWK that
      // GET /lti/jwks publishes. Without it, exportJWK throws at boot and /lti/jwks never works.
      // (The ephemeral path above passes the same flag to generateKeyPair for the same reason.)
      const privateKey = await importPKCS8(entry.privateKeyPkcs8Pem, 'RS256', { extractable: true });
      return { kid: entry.kid, status: entry.status, privateKey, publicJwk: await toPublicJwk(privateKey, entry.kid) };
    }),
  );
}

// Consumed by Phase 4's Canvas service-token client, which signs the `client_assertion` JWT for the
// OAuth2 token endpoint with the active key. Phase 3 itself only publishes the public halves at
// GET /lti/jwks, so within this plan this function is exercised only by its own unit test.
export function getActiveSigningKey(keys: ToolSigningKey[]): ToolSigningKey {
  const active = keys.find((k) => k.status === 'active');
  if (!active) {
    throw new Error('No active tool signing key configured.');
  }
  return active;
}
