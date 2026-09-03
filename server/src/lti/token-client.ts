//
// OAuth 2.0 Client Credentials grant against Canvas's token endpoint (spec §16), using a signed JWT
// client assertion. Access tokens are cached in-memory per registration + normalized-scope-set and
// reused until ~60s before expiry (spec §16.1). Accepted limitation: the in-memory cache does not
// survive restarts or scale horizontally -- fine at this app's single-instance scale.

import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';

export interface SigningKeyRef {
  kid: string;
  privateKey: CryptoKey;
}

export interface TokenClientRegistration {
  id: string;
  clientId: string;
  tokenEndpoint: string;
  tokenAudience: string;
}

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
}

const tokenCache = new Map<string, CachedToken>();

function cacheKey(registrationId: string, scopes: string[]): string {
  return `${registrationId}:${[...scopes].sort().join(' ')}`;
}

export async function buildClientAssertion(
  registration: TokenClientRegistration,
  signingKey: SigningKeyRef,
): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid: signingKey.kid })
    .setSubject(registration.clientId)
    .setIssuer(registration.clientId)
    .setAudience(registration.tokenAudience) // spec §16: the configured authorization-server audience
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + 300)
    .setJti(randomUUID())
    .sign(signingKey.privateKey);
}

export async function getAccessToken(
  registration: TokenClientRegistration,
  scopes: string[],
  deps: { signingKey: SigningKeyRef; fetchImpl?: typeof fetch },
): Promise<string> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const key = cacheKey(registration.id, scopes);
  const cached = tokenCache.get(key);
  const nowMs = Date.now();
  if (cached && cached.expiresAtMs - 60_000 > nowMs) {
    return cached.accessToken;
  }

  const assertion = await buildClientAssertion(registration, deps.signingKey);
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    client_assertion: assertion,
    scope: scopes.join(' '),
  });

  const response = await fetchImpl(registration.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    redirect: 'manual',
  });

  if (response.status >= 300 && response.status < 400) {
    throw new Error('Canvas token endpoint returned a redirect; redirects are not followed.');
  }
  if (!response.ok) {
    throw new Error(`Canvas token endpoint returned HTTP ${response.status}`);
  }

  const json = (await response.json()) as { access_token: string; expires_in: number };
  tokenCache.set(key, { accessToken: json.access_token, expiresAtMs: nowMs + json.expires_in * 1000 });
  return json.access_token;
}

export function clearAccessTokenCache(registrationId: string, scopes: string[]): void {
  tokenCache.delete(cacheKey(registrationId, scopes));
}
