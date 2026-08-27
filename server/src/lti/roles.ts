// Standard 1EdTech LTI context-role and institution-role URIs recognized as instructor/administrator.
// This set was written from the published 1EdTech role vocabulary, NOT from an observed Canvas
// launch, so it is the highest-risk assumption in this phase: if Canvas emits a role URI outside
// this set for a real instructor, every legitimate launch 403s, and if it emits one of these for a
// non-teacher, an unauthorized user gets in. It MUST therefore be verified against a real Canvas
// launch payload during the manual Canvas Developer Key verification in
// docs/canvas-installation.md (step 5) before this is trusted as load-bearing security logic.
export const AUTHORIZED_INSTRUCTOR_ROLE_URIS = new Set<string>([
  'http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor',
  'http://purl.imsglobal.org/vocab/lis/v2/membership#Administrator',
  'http://purl.imsglobal.org/vocab/lis/v2/institution/role#Instructor',
  'http://purl.imsglobal.org/vocab/lis/v2/institution/role#Administrator',
  'http://purl.imsglobal.org/vocab/lis/v2/system/role#Administrator',
]);

export function authorizeInstructorRole(roles: string[]): boolean {
  return roles.some((role) => AUTHORIZED_INSTRUCTOR_ROLE_URIS.has(role));
}
