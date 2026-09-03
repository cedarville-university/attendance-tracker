// server/src/auth/admin-middleware.ts
//
// Auth for the admin/setup routes (Feature 3). A request is authorized when EITHER:
//   - it carries a valid session cookie whose roles include an LTI Administrator role, OR
//   - it sends `x-setup-token` matching the configured SETUP_TOKEN (constant-time compare).
//
// The token path is a dev bootstrap: it needs no session and no CSRF token (there is no session
// cookie to ride a cross-site form). It is only available when SETUP_TOKEN is set. The session
// path DOES go through CSRF on mutations -- see `createAdminMutationPreHandlers`.
//
// Preserves the "send, don't return" hook convention from middleware.ts (returning the reply from
// a Promise<void> hook fails typecheck).

import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Database } from '../database/client.js';
import { authorizeAdminRole } from '../lti/roles.js';
import { findValidSession } from './session.js';
import { SESSION_COOKIE_NAME } from './cookies.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by requireAdmin when the request authenticated via x-setup-token (no session, no CSRF). */
    adminViaToken?: boolean;
  }
}

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export interface RequireAdminDeps {
  db: Database;
  setupToken: string | undefined;
}

export function createRequireAdmin(deps: RequireAdminDeps): PreHandler {
  return async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const headerToken = request.headers['x-setup-token'];
    const providedToken = Array.isArray(headerToken) ? headerToken[0] : headerToken;
    if (deps.setupToken && providedToken && constantTimeEquals(deps.setupToken, providedToken)) {
      request.adminViaToken = true;
      return;
    }

    const cookie = request.cookies?.[SESSION_COOKIE_NAME];
    if (cookie) {
      const session = await findValidSession(deps.db, cookie);
      if (session && authorizeAdminRole(session.roles)) {
        request.appSession = session;
        return;
      }
    }

    reply.code(401).send({ error: 'admin_unauthorized' });
  };
}

/**
 * PreHandler chain for an admin mutation: requireAdmin, then CSRF unless the request authenticated
 * via the setup token (which has no session cookie to protect).
 */
export function createAdminMutationPreHandlers(requireAdmin: PreHandler, requireCsrf: PreHandler): PreHandler[] {
  const maybeCsrf: PreHandler = async (request, reply) => {
    if (request.adminViaToken) return;
    await requireCsrf(request, reply);
  };
  return [requireAdmin, maybeCsrf];
}
