// server/src/lti/types.ts
export interface LtiInstitution {
  id: string;
  slug: string;
  displayName: string;
  enabled: boolean;
}

export interface LtiRegistration {
  id: string;
  institutionId: string;
  issuer: string;
  clientId: string;
  oidcAuthEndpoint: string;
  tokenEndpoint: string;
  tokenAudience: string;
  platformJwksUri: string;
  enabled: boolean;
}

export interface LtiDeployment {
  id: string;
  registrationId: string;
  deploymentId: string;
  enabled: boolean;
}

export interface EnabledDeployment {
  institution: LtiInstitution;
  registration: LtiRegistration;
  deployment: LtiDeployment;
}

// NOTE: this file deliberately does NOT declare a hand-written `LaunchClaims`/`LtiContextClaim`
// pair. The launch JWT's claim shape has exactly one source of truth: the zod schema in
// `lti/claims.ts` (Task 16) and its inferred `ValidatedLtiClaims` type. A parallel hand-written
// interface would be a second, unenforced definition that could drift from the validator.
