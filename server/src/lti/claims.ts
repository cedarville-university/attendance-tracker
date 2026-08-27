import { z } from 'zod';

const ltiClaimsSchema = z.object({
  sub: z.string().min(1),
  nonce: z.string().min(1),
  'https://purl.imsglobal.org/spec/lti/claim/version': z.literal('1.3.0'),
  'https://purl.imsglobal.org/spec/lti/claim/message_type': z.literal('LtiResourceLinkRequest'),
  'https://purl.imsglobal.org/spec/lti/claim/deployment_id': z.string().min(1),
  'https://purl.imsglobal.org/spec/lti/claim/context': z.object({
    id: z.string().min(1),
    label: z.string().optional(),
    title: z.string().optional(),
  }),
  'https://purl.imsglobal.org/spec/lti/claim/roles': z.array(z.string()).min(1),
});

export type ValidatedLtiClaims = z.infer<typeof ltiClaimsSchema>;
export type ClaimsValidationFailureReason = 'wrong_version' | 'wrong_message_type' | 'missing_context' | 'missing_roles';
export type ClaimsValidationResult =
  | { ok: true; claims: ValidatedLtiClaims }
  | { ok: false; reason: ClaimsValidationFailureReason };

export function validateLtiClaims(rawClaims: unknown): ClaimsValidationResult {
  const parsed = ltiClaimsSchema.safeParse(rawClaims);
  if (parsed.success) {
    return { ok: true, claims: parsed.data };
  }

  // Match on the *first* path segment so a nested failure (e.g. context present but its `id`
  // missing, path ['...#context', 'id']) still classifies as that claim's failure rather than
  // falling through to the invariant throw below.
  const failsAt = (claim: string) => parsed.error.issues.some((issue) => issue.path[0] === claim);

  if (failsAt('https://purl.imsglobal.org/spec/lti/claim/version')) return { ok: false, reason: 'wrong_version' };
  if (failsAt('https://purl.imsglobal.org/spec/lti/claim/message_type')) return { ok: false, reason: 'wrong_message_type' };
  if (failsAt('https://purl.imsglobal.org/spec/lti/claim/context')) return { ok: false, reason: 'missing_context' };
  if (failsAt('https://purl.imsglobal.org/spec/lti/claim/roles')) return { ok: false, reason: 'missing_roles' };

  // launch.ts only calls this after JWT signature/lifetime checks already passed, and Canvas's own
  // JWT always carries sub/nonce, so no §45 test case reaches this branch -- it's an invariant guard.
  throw new Error(`Unexpected LTI claims validation failure: ${parsed.error.message}`);
}
