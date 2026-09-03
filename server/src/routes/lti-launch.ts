import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { verifyLaunch, type VerifyLaunchDeps } from '../lti/launch.js';
import { SESSION_COOKIE_NAME, buildSessionCookieOptions } from '../auth/cookies.js';

const launchBodySchema = z.object({
  state: z.string().optional(),
  id_token: z.string().optional(),
});

const REASON_TO_STATUS: Record<string, number> = {
  learner_only_role: 403,
};

export interface LtiLaunchRouteDeps extends VerifyLaunchDeps {
  appBaseUrl: string;
}

export function registerLtiLaunchRoute(app: FastifyInstance, deps: LtiLaunchRouteDeps): void {
  app.post('/lti/launch', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = launchBodySchema.safeParse(request.body);
    const input = parsed.success ? parsed.data : {};

    const result = await verifyLaunch({ state: input.state, idToken: input.id_token }, deps);

    if (!result.ok) {
      const status = REASON_TO_STATUS[result.reason] ?? 400;
      return reply.code(status).send({ error: result.reason });
    }

    reply.setCookie(SESSION_COOKIE_NAME, result.session.token, buildSessionCookieOptions(deps.appBaseUrl, deps.sessionTtlHours));
    // `result.targetLinkUri` is the value the matching OIDC transaction stored at login time, and
    // /lti/login only ever stores a value that passed the exact-match ALLOWED_TARGET_LINK_URIS
    // allowlist (spec §12.1). That allowlist -- not this line -- is what makes redirecting to a
    // launch-supplied destination safe; never redirect to a target_link_uri read out of the
    // current request. Hardcoding one page here would silently break multi-entry allowlists.
    return reply.redirect(result.targetLinkUri, 303);
  });
}
