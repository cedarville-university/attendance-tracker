import Fastify from 'fastify';
import { describe, it, expect } from 'vitest';
import { registerLtiJwksRoute } from '../../src/routes/lti-jwks.js';
import { testSigningKeyProvider } from '../support/signing-keys.js';

describe('GET /lti/jwks', () => {
  it('returns the public JWKS with no private material', async () => {
    const app = Fastify({ logger: false });
    const provider = await testSigningKeyProvider();
    registerLtiJwksRoute(app, provider);

    const response = await app.inject({ method: 'GET', url: '/lti/jwks' });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]).not.toHaveProperty('d');
    expect(body.keys[0].kid).toBe(provider.list()[0].kid);
  });
});
