// server/src/security/csp.ts
//
// Content-Security-Policy directives for @fastify/helmet (spec §31.3). Extracted verbatim from the
// inline block that lived in server/src/index.ts through Phase 6 so it can be unit-tested and so
// server/tests/routes/hardening.test.ts no longer needs a hand-maintained copy.

export function buildCspDirectives(
  appBaseUrl: string,
  canvasOidcOrigins: string[],
): Record<string, string[] | null> {
  const directives: Record<string, string[] | null> = {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'"],
    connectSrc: ["'self'"],
    objectSrc: ["'none'"],
    baseUri: ["'none'"],
    // Spec §31.3: `form-action 'self' <configured Canvas OIDC destinations>`. 'self' covers
    // APP_BASE_URL; the extra entries are the origins of the oidc_auth_endpoint values in
    // lti_registrations -- /lti/login redirects the browser there and Canvas form-POSTs the
    // launch back to /lti/launch.
    formAction: ["'self'", ...canvasOidcOrigins],
    frameAncestors: ["'none'"],
  };
  if (!appBaseUrl.startsWith('https://')) {
    // Helmet's default CSP adds `upgrade-insecure-requests`, which rewrites every
    // http://localhost:3000 request to https:// and breaks local HTTP dev. `null` removes one of
    // helmet's own defaults.
    directives.upgradeInsecureRequests = null;
  }
  return directives;
}
