// server/src/auth/csrf.ts
import { timingSafeEqual } from 'node:crypto';

export function verifyCsrfToken(sessionCsrfSecret: string, providedToken: string | undefined): boolean {
  if (!providedToken) return false;
  const expected = Buffer.from(sessionCsrfSecret);
  const actual = Buffer.from(providedToken);
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

export function verifyOrigin(expectedOrigin: string, providedOrigin: string | undefined): boolean {
  return providedOrigin === expectedOrigin;
}

// Spec §15: "Reject form-encoded mutation endpoints except the LTI launch endpoint itself."
// `@fastify/formbody` is registered app-wide so POST /lti/launch can parse Canvas's `form_post`
// response mode, which means every other POST would otherwise also accept a form body -- and a
// cross-site HTML <form> can be submitted without JavaScript and without a preflight. Blocking the
// two form encodings on CSRF-protected routes removes that class of request entirely. POST
// /lti/launch does NOT use requireCsrf (it is authenticated by the signed id_token, not by a
// session cookie), so it is unaffected by this check.
const REJECTED_MUTATION_MEDIA_TYPES = new Set(['application/x-www-form-urlencoded', 'multipart/form-data']);

export function isRejectedMutationContentType(contentTypeHeader: string | undefined): boolean {
  if (!contentTypeHeader) return false;
  const mediaType = contentTypeHeader.split(';')[0].trim().toLowerCase();
  return REJECTED_MUTATION_MEDIA_TYPES.has(mediaType);
}
