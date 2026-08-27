// server/src/lti/registrations.ts
import { eq, and } from 'drizzle-orm';
import type { Database } from '../database/client.js';
import { institutions, ltiRegistrations, ltiDeployments, courses } from '../database/schema.js';
import type { EnabledDeployment, LtiRegistration, LtiDeployment } from './types.js';

export async function findEnabledDeployment(
  db: Database,
  iss: string,
  clientId: string,
  deploymentId: string,
): Promise<EnabledDeployment | null> {
  const rows = await db
    .select({ institution: institutions, registration: ltiRegistrations, deployment: ltiDeployments })
    .from(ltiDeployments)
    .innerJoin(ltiRegistrations, eq(ltiDeployments.registrationId, ltiRegistrations.id))
    .innerJoin(institutions, eq(ltiRegistrations.institutionId, institutions.id))
    .where(
      and(
        eq(ltiRegistrations.issuer, iss),
        eq(ltiRegistrations.clientId, clientId),
        eq(ltiDeployments.deploymentId, deploymentId),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row || !row.institution.enabled || !row.registration.enabled || !row.deployment.enabled) {
    return null;
  }

  return {
    institution: { id: row.institution.id, slug: row.institution.slug, displayName: row.institution.displayName, enabled: row.institution.enabled },
    registration: {
      id: row.registration.id,
      institutionId: row.registration.institutionId,
      issuer: row.registration.issuer,
      clientId: row.registration.clientId,
      oidcAuthEndpoint: row.registration.oidcAuthEndpoint,
      tokenEndpoint: row.registration.tokenEndpoint,
      tokenAudience: row.registration.tokenAudience,
      platformJwksUri: row.registration.platformJwksUri,
      enabled: row.registration.enabled,
    },
    deployment: { id: row.deployment.id, registrationId: row.deployment.registrationId, deploymentId: row.deployment.deploymentId, enabled: row.deployment.enabled },
  };
}

export async function findRegistrationById(db: Database, id: string): Promise<LtiRegistration | null> {
  const rows = await db.select().from(ltiRegistrations).where(eq(ltiRegistrations.id, id)).limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    institutionId: row.institutionId,
    issuer: row.issuer,
    clientId: row.clientId,
    oidcAuthEndpoint: row.oidcAuthEndpoint,
    tokenEndpoint: row.tokenEndpoint,
    tokenAudience: row.tokenAudience,
    platformJwksUri: row.platformJwksUri,
    enabled: row.enabled,
  };
}

export async function findDeploymentByBusinessId(
  db: Database,
  registrationId: string,
  deploymentId: string,
): Promise<LtiDeployment | null> {
  const rows = await db
    .select()
    .from(ltiDeployments)
    .where(and(eq(ltiDeployments.registrationId, registrationId), eq(ltiDeployments.deploymentId, deploymentId)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { id: row.id, registrationId: row.registrationId, deploymentId: row.deploymentId, enabled: row.enabled };
}

export interface FindOrCreateCourseParams {
  institutionId: string;
  deploymentId: string;
  ltiContextId: string;
  label?: string;
  title?: string;
}

export async function findOrCreateCourse(db: Database, params: FindOrCreateCourseParams): Promise<{ id: string }> {
  const courseMatch = and(eq(courses.deploymentId, params.deploymentId), eq(courses.ltiContextId, params.ltiContextId));

  // Fast path: the row already exists from a prior launch.
  const existing = await db.select().from(courses).where(courseMatch).limit(1);
  if (existing[0]) {
    return { id: existing[0].id };
  }

  // First-time path: insert, but let a concurrent duplicate insert lose gracefully via the
  // unique(deploymentId, ltiContextId) constraint instead of throwing.
  const [inserted] = await db
    .insert(courses)
    .values({
      institutionId: params.institutionId,
      deploymentId: params.deploymentId,
      ltiContextId: params.ltiContextId,
      label: params.label ?? null,
      title: params.title ?? null,
    })
    .onConflictDoNothing({ target: [courses.deploymentId, courses.ltiContextId] })
    .returning();
  if (inserted) {
    return { id: inserted.id };
  }

  // We lost the race: another concurrent call already committed the row. Fetch it.
  const [winner] = await db.select().from(courses).where(courseMatch).limit(1);
  if (!winner) {
    throw new Error('findOrCreateCourse: insert conflicted but no row found on fallback select');
  }
  return { id: winner.id };
}
