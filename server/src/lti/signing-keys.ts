import { generateKeyPair, exportJWK, importPKCS8 } from 'jose';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

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

// Validates the *shape* of LTI_TOOL_SIGNING_KEYS_JSON after it has been parsed as JSON.
// `privateKeyPkcs8Pem` never appears in a thrown error: zod's error.message for a type
// mismatch reports only `code`/`path`/`expected`/`received-type-name`, never the received
// value itself (verified empirically; see task-6-report.md, Fix pass). An `invalid_value`
// mismatch (the `status` enum) does echo the received value, which is fine since `status`
// never holds key material.
const rawSigningKeyConfigSchema = z.object({
  kid: z.string().min(1),
  privateKeyPkcs8Pem: z.string().min(1),
  status: z.enum(['active', 'previous']),
});

const rawSigningKeyConfigArraySchema = z
  .array(rawSigningKeyConfigSchema)
  // At most one `active` entry: `getActiveSigningKey`'s `.find()` would otherwise silently
  // take the first of several and give no signal that the config is ambiguous.
  .refine((entries) => entries.filter((entry) => entry.status === 'active').length <= 1, {
    message: 'LTI_TOOL_SIGNING_KEYS_JSON must contain at most one entry with status "active"',
  });

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

  // `JSON.parse` on malformed input can throw a message that embeds a fragment of the raw
  // input (e.g. pasting a raw PEM in unwrapped: `Unexpected token 'M', "MIIEvQIBAD"... is
  // not valid JSON` — reproduced empirically, see task-6-report.md). Since `json` may be raw
  // key material (spec §31.8: never log signing/private key material), the caught error and
  // its message are discarded entirely in favor of a fixed, constant message.
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(json);
  } catch {
    throw new Error('Malformed LTI_TOOL_SIGNING_KEYS_JSON');
  }

  const result = rawSigningKeyConfigArraySchema.safeParse(parsedJson);
  if (!result.success) {
    throw new Error(`Invalid LTI_TOOL_SIGNING_KEYS_JSON: ${result.error.message}`);
  }
  const raw: RawSigningKeyConfig[] = result.data;
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
