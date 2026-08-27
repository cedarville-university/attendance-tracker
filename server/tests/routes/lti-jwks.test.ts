import Fastify from 'fastify';
import { describe, it, expect } from 'vitest';
import { registerLtiJwksRoute } from '../../src/routes/lti-jwks.js';
import { loadSigningKeysFromEnv } from '../../src/lti/signing-keys.js';

describe('GET /lti/jwks', () => {
  it('returns the public JWKS with no private material', async () => {
    const keys = await loadSigningKeysFromEnv(undefined);
    const app = Fastify({ logger: false });
    registerLtiJwksRoute(app, keys);

    const response = await app.inject({ method: 'GET', url: '/lti/jwks' });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]).not.toHaveProperty('d');
    expect(body.keys[0].kid).toBe(keys[0].kid);
  });
});
