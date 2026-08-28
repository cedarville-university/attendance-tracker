import { generateKeyPair, decodeProtectedHeader, decodeJwt } from 'jose';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  buildClientAssertion,
  getAccessToken,
  clearAccessTokenCache,
  type SigningKeyRef,
  type TokenClientRegistration,
} from '../../src/lti/token-client.js';
import { MockCanvasPlatform } from '../support/mock-canvas.js';

describe('token-client', () => {
  let platform: MockCanvasPlatform;
  let signingKey: SigningKeyRef;
  let registration: TokenClientRegistration;

  beforeAll(async () => {
    platform = new MockCanvasPlatform();
    await platform.start();
    const { privateKey } = await generateKeyPair('RS256');
    signingKey = { kid: 'test-kid-1', privateKey };
    registration = {
      id: 'reg-1',
      clientId: 'client-abc',
      tokenEndpoint: platform.tokenUrl,
      // Deliberately DIFFERENT from tokenEndpoint, to prove the assertion signs `aud` as tokenAudience.
      tokenAudience: 'https://sso.canvaslms.com/api/lti/authorize_redirect',
    };
  });

  afterAll(async () => {
    await platform.stop();
  });

  beforeEach(() => {
    clearAccessTokenCache(registration.id, ['scope-a']);
    clearAccessTokenCache(registration.id, ['scope-b']);
  });

  it('builds a client assertion with the required claims, kid, and aud = tokenAudience', async () => {
    const assertion = await buildClientAssertion(registration, signingKey);
    const header = decodeProtectedHeader(assertion);
    const payload = decodeJwt(assertion);

    expect(header.alg).toBe('RS256');
    expect(header.kid).toBe('test-kid-1');
    expect(payload.sub).toBe('client-abc');
    expect(payload.iss).toBe('client-abc');
    expect(payload.aud).toBe('https://sso.canvaslms.com/api/lti/authorize_redirect');
    expect(typeof payload.jti).toBe('string');
    expect(payload.exp).toBeDefined();
    expect(payload.iat).toBeDefined();
  });

  it('fetches and caches an access token, reusing it on a second call with the same scopes', async () => {
    const first = await getAccessToken(registration, ['scope-a'], { signingKey });
    const second = await getAccessToken(registration, ['scope-a'], { signingKey });
    expect(second).toBe(first);
  });

  it('keeps token caches for different scope sets isolated', async () => {
    const scopeA = await getAccessToken(registration, ['scope-a'], { signingKey });
    const scopeB = await getAccessToken(registration, ['scope-b'], { signingKey });
    expect(scopeA).not.toBe(scopeB);
  });

  it('re-fetches after the cache is cleared', async () => {
    const first = await getAccessToken(registration, ['scope-a'], { signingKey });
    clearAccessTokenCache(registration.id, ['scope-a']);
    const second = await getAccessToken(registration, ['scope-a'], { signingKey });
    expect(second).not.toBe(first);
  });
});
