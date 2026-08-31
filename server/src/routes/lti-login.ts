import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { buildLoginRedirect, type LoginDeps } from '../lti/login.js';

const loginParamsSchema = z.object({
  iss: z.string().min(1),
  login_hint: z.string().min(1),
  target_link_uri: z.string().min(1),
  client_id: z.string().min(1),
  // LTI 1.3 OIDC third-party login initiation names this `lti_deployment_id`. The bare
  // `deployment_id` is the *id_token claim* name (used at /lti/launch), not the login parameter --
  // real Canvas sends `lti_deployment_id` here (spec §12.1's list was imprecise). The spec marks it
  // OPTIONAL, but this is a Canvas-only integration, Canvas always sends it, and
  // findEnabledDeployment() needs it to key the lookup -- so require it deliberately.
  lti_deployment_id: z.string().min(1),
  // Opaque; the tool must echo it unchanged on the authorization request (LTI 1.3 §5.1.1.2).
  // Spec-optional, but Canvas always sends it and rejects the redirect without it -- require it.
  lti_message_hint: z.string().min(1),
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
        deploymentId: parsed.data.lti_deployment_id,
        ltiMessageHint: parsed.data.lti_message_hint,
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
