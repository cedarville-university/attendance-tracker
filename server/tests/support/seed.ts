// server/tests/support/seed.ts
import { randomUUID } from 'node:crypto';
import type { Database } from '../../src/database/client.js';
import { institutions, ltiRegistrations, ltiDeployments, courses } from '../../src/database/schema.js';
import type { MockCanvasPlatform } from './mock-canvas.js';

export interface SeededRegistration {
  institutionId: string;
  registrationId: string;
  deploymentRowId: string;
  clientId: string;
  deploymentId: string;
}

export interface SeedOverrides {
  clientId?: string;
  deploymentId?: string;
  /** Override the registration's oidc_auth_endpoint column (defaults to the mock-canvas host). */
  oidcAuthEndpoint?: string;
}

export async function seedInstitutionAndRegistration(
  db: Database,
  platform: MockCanvasPlatform,
  overrides: SeedOverrides = {},
): Promise<SeededRegistration> {
  const clientId = overrides.clientId ?? 'mock-client-id';
  const deploymentId = overrides.deploymentId ?? 'mock-deployment-1';

  const [institution] = await db
    .insert(institutions)
    .values({ slug: `mock-${randomUUID()}`, displayName: 'Mock University', timezone: 'UTC', enabled: true })
    .returning();

  const [registration] = await db
    .insert(ltiRegistrations)
    .values({
      institutionId: institution.id,
      issuer: platform.issuer,
      clientId,
      oidcAuthEndpoint: overrides.oidcAuthEndpoint ?? 'https://mock-canvas.test/api/lti/authorize_redirect',
      // Point at the live mock so tests that actually acquire a client-credentials token
      // (refreshCourseRoster) reach it -- mirrors platformJwksUri already using the live port.
      tokenEndpoint: platform.tokenUrl,
      tokenAudience: 'https://mock-canvas.test/login/oauth2/token',
      platformJwksUri: platform.jwksUri,
      enabled: true,
    })
    .returning();

  const [deployment] = await db
    .insert(ltiDeployments)
    .values({ registrationId: registration.id, deploymentId, enabled: true, configuration: {} })
    .returning();

  return { institutionId: institution.id, registrationId: registration.id, deploymentRowId: deployment.id, clientId, deploymentId };
}

export interface SeededCourse extends SeededRegistration {
  courseId: string;
}

export async function seedInstitutionAndCourse(
  db: Database,
  platform: MockCanvasPlatform,
  overrides: SeedOverrides & { nrpsUrl?: string | null; agsLineitemsUrl?: string | null } = {},
): Promise<SeededCourse> {
  const seeded = await seedInstitutionAndRegistration(db, platform, overrides);
  const [course] = await db
    .insert(courses)
    .values({
      institutionId: seeded.institutionId,
      deploymentId: seeded.deploymentRowId, // lti_deployments.id ROW UUID -- never the business string
      ltiContextId: `ctx-${randomUUID()}`,
      label: 'TEST-101',
      title: 'Test Course',
      nrpsUrl: overrides.nrpsUrl ?? null,
      agsLineitemsUrl: overrides.agsLineitemsUrl ?? null,
    })
    .returning();
  return { ...seeded, courseId: course.id };
}
