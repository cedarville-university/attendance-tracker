// types.ts
//
// Server-side identity resolution: turns a scanned card code into a
// normalized student identity. Mirrors the shape web/lookup.js used to
// produce client-side, before Phase 2 moved lookups (and any credentials)
// behind the backend -- see IdentityResolution below.
//
// `missing-credentials` is intentionally not one of the error kinds here:
// on the client, missing credentials were a runtime state the professor
// could hit by never filling in the Settings panel. Server-side, resolver
// configuration is validated once at startup instead, so a request can
// never reach a resolver that lacks what it needs.

export type IdentityErrorKind = 'timeout' | 'network' | 'http-status' | 'bad-json' | 'missing-university-id';

export interface IdentityResolution {
  ok: boolean;
  universityId: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  raw: unknown;
  error: { kind: IdentityErrorKind; message: string } | null;
}

export interface IdentityResolver {
  resolveCard(cardCode: string): Promise<IdentityResolution>;
}
