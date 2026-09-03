// server/src/auth/middleware.ts
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Database } from '../database/client.js';
import { findValidSession, type AppSession } from './session.js';
import { verifyCsrfToken, verifyOrigin, isRejectedMutationContentType } from './csrf.js';
import { SESSION_COOKIE_NAME } from './cookies.js';

declare module 'fastify' {
  interface FastifyRequest {
    appSession?: AppSession;
  }
}

// NOTE on the `reply.code(...).send(...); return;` pattern used throughout this file: these are
// Fastify preHandler hooks declared as `Promise<void>`, and a Fastify hook signals "stop here, the
// response is already sent" by *sending*, not by returning the reply object. Writing
// `return reply.code(401).send(...)` returns a FastifyReply from a `Promise<void>` function and
// fails `npm run typecheck` with TS2322 ("Type 'FastifyReply' is not assignable to type 'void'").
export function createRequireSession(db: Database) {
  return async function requireSession(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const token = request.cookies?.[SESSION_COOKIE_NAME];
    if (!token) {
      reply.code(401).send({ error: 'unauthenticated' });
      return;
    }
    const session = await findValidSession(db, token);
    if (!session) {
      reply.code(401).send({ error: 'unauthenticated' });
      return;
    }
    request.appSession = session;
  };
}

export function createRequireCsrf(expectedOrigin: string) {
  return async function requireCsrf(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const session = request.appSession;
    if (!session) {
      reply.code(401).send({ error: 'unauthenticated' });
      return;
    }
    // Spec §15: form-encoded bodies are never acceptable on a CSRF-protected mutation. The LTI
    // launch endpoint is the documented exception and does not use this preHandler.
    if (isRejectedMutationContentType(request.headers['content-type'])) {
      reply.code(403).send({ error: 'form_encoded_mutation_rejected' });
      return;
    }
    const origin = request.headers.origin;
    const csrfHeader = request.headers['x-csrf-token'];
    const providedToken = Array.isArray(csrfHeader) ? csrfHeader[0] : csrfHeader;
    if (!verifyOrigin(expectedOrigin, origin) || !verifyCsrfToken(session.csrfSecret, providedToken)) {
      reply.code(403).send({ error: 'csrf_check_failed' });
      return;
    }
  };
}
