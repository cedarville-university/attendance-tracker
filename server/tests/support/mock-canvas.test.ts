import { describe, it, expect, afterEach } from 'vitest';
import { jwtVerify, importJWK, decodeProtectedHeader } from 'jose';
import { MockCanvasPlatform } from './mock-canvas.js';

describe('MockCanvasPlatform', () => {
  let platform: MockCanvasPlatform | undefined;

  afterEach(async () => {
    await platform?.stop();
    platform = undefined;
  });

  it('mints ID tokens that verify against its own published JWKS', async () => {
    platform = new MockCanvasPlatform();
    await platform.start();

    const token = await platform.mintIdToken();
    const jwksResponse = (await fetch(platform.jwksUri).then((r) => r.json())) as { keys: Record<string, unknown>[] };
    expect(jwksResponse.keys).toHaveLength(1);

    const publicKey = await importJWK(jwksResponse.keys[0], 'RS256');
    const { payload } = await jwtVerify(token, publicKey);
    expect(payload.iss).toBe(platform.issuer);
    expect(payload['https://purl.imsglobal.org/spec/lti/claim/version']).toBe('1.3.0');
  });

  it('publishNewKey/unpublishKey control what appears in the JWKS response', async () => {
    platform = new MockCanvasPlatform();
    await platform.start();

    await platform.publishNewKey('rotated-kid');
    let jwksResponse = (await fetch(platform.jwksUri).then((r) => r.json())) as { keys: { kid: string }[] };
    expect(jwksResponse.keys.map((k) => k.kid)).toContain('rotated-kid');

    platform.unpublishKey('rotated-kid');
    jwksResponse = (await fetch(platform.jwksUri).then((r) => r.json())) as { keys: { kid: string }[] };
    expect(jwksResponse.keys.map((k) => k.kid)).not.toContain('rotated-kid');
  });

  it('mintIdToken supports omitting context/roles for the missing_context/missing_roles test cases', async () => {
    platform = new MockCanvasPlatform();
    await platform.start();

    const token = await platform.mintIdToken({ contextId: null, roles: null });
    const jwksResponse = (await fetch(platform.jwksUri).then((r) => r.json())) as { keys: Record<string, unknown>[] };
    const publicKey = await importJWK(jwksResponse.keys[0], 'RS256');
    const { payload } = await jwtVerify(token, publicKey);

    expect(payload['https://purl.imsglobal.org/spec/lti/claim/context']).toBeUndefined();
    expect(payload['https://purl.imsglobal.org/spec/lti/claim/roles']).toBeUndefined();
  });

  it('mintIdToken alg override rewrites the protected header for the unsupported_algorithm case', async () => {
    platform = new MockCanvasPlatform();
    await platform.start();

    const token = await platform.mintIdToken({ nonce: 'n1' }, { alg: 'RS384' });

    const header = decodeProtectedHeader(token);
    expect(header.alg).toBe('RS384');
    expect(header.kid).toBe('default-kid');

    const segments = token.split('.');
    expect(segments).toHaveLength(3);
    const decodedPayload = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8')) as { nonce?: string };
    expect(decodedPayload.nonce).toBe('n1');
  });
});
