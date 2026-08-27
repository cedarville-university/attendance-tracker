import type { FastifyInstance } from 'fastify';
import { buildJwksResponse } from '../lti/jwks-route.js';
import type { ToolSigningKey } from '../lti/signing-keys.js';

export function registerLtiJwksRoute(app: FastifyInstance, signingKeys: ToolSigningKey[]): void {
  app.get('/lti/jwks', async () => buildJwksResponse(signingKeys));
}
