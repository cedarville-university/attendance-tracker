// server/src/lti/registrations.ts
import { eq, and, sql } from 'drizzle-orm';
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
  nrpsUrl?: string | null;
  agsLineitemsUrl?: string | null;
}

export async function findOrCreateCourse(db: Database, params: FindOrCreateCourseParams): Promise<{ id: string }> {
  const courseMatch = and(eq(courses.deploymentId, params.deploymentId), eq(courses.ltiContextId, params.ltiContextId));

  const resolveId = async (): Promise<string> => {
    const existing = await db.select().from(courses).where(courseMatch).limit(1);
    if (existing[0]) return existing[0].id;

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
    if (inserted) return inserted.id;

    const [winner] = await db.select().from(courses).where(courseMatch).limit(1);
    if (!winner) {
      throw new Error('findOrCreateCourse: insert conflicted but no row found on fallback select');
    }
    return winner.id;
  };

  const courseId = await resolveId();

  // Refresh launch metadata on EVERY launch. Canvas can rotate the NRPS/AGS URLs, so overwrite them
  // whenever the claim is present; never null out a previously-good value when a later launch omits it.
  // Build the SET payload as an inline object literal with conditional spreads so Drizzle infers
  // `PgUpdateSetSource<typeof courses>` directly — a `const launchUpdate: Record<string, unknown>`
  // annotation is a strict-mode `.set()` typecheck error.
  await db
    .update(courses)
    .set({
      lastLaunchedAt: sql`now()`,
      updatedAt: sql`now()`,
      ...(params.nrpsUrl != null ? { nrpsUrl: params.nrpsUrl } : {}),
      ...(params.agsLineitemsUrl != null ? { agsLineitemsUrl: params.agsLineitemsUrl } : {}),
    })
    .where(eq(courses.id, courseId));

  return { id: courseId };
}
