import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { buildLoginRedirect, type LoginDeps } from '../lti/login.js';

const loginParamsSchema = z.object({
  iss: z.string().min(1),
  login_hint: z.string().min(1),
  target_link_uri: z.string().min(1),
  client_id: z.string().min(1),
  deployment_id: z.string().min(1),
});

export function registerLtiLoginRoute(app: FastifyInstance, deps: LoginDeps): void {
  async function handler(request: FastifyRequest, reply: FastifyReply) {
    const source = request.method === 'GET' ? request.query : request.body;
    const parsed = loginParamsSchema.safeParse(source);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid /lti/login request.' });
    }

    const result = await buildLoginRedirect(
      {
        iss: parsed.data.iss,
        loginHint: parsed.data.login_hint,
        targetLinkUri: parsed.data.target_link_uri,
        clientId: parsed.data.client_id,
        deploymentId: parsed.data.deployment_id,
      },
      deps,
    );

    if (!result.ok) {
      return reply.code(400).send({ error: result.reason });
    }

    return reply.redirect(result.redirectUrl, 302);
  }

  app.get('/lti/login', handler);
  app.post('/lti/login', handler);
}
