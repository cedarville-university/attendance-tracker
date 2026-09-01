import type { FastifyInstance } from 'fastify';
import { buildJwksResponse } from '../lti/jwks-route.js';
import type { SigningKeyProvider } from '../lti/signing-key-store.js';

export function registerLtiJwksRoute(app: FastifyInstance, signingKeyProvider: SigningKeyProvider): void {
  // Read the provider at request time so an admin key rotation is served without a restart.
  app.get('/lti/jwks', async () => buildJwksResponse(signingKeyProvider.list()));
}
