// server/src/attendance/ags-course-context.ts
//
// Shared by both worker passes (grade-worker.ts posts scores; line-item-deletion.ts DELETEs the
// line item). Resolves a course to its institution + the LTI registration needed to mint an AGS
// client-credentials token.

import { eq } from 'drizzle-orm';
import type { Database } from '../database/client.js';
import { courses, institutions, ltiDeployments, ltiRegistrations } from '../database/schema.js';

export interface CourseAgsContext {
  courseId: string;
  institutionId: string;
  agsLineitemsUrl: string | null;
  registration: { id: string; clientId: string; tokenEndpoint: string; tokenAudience: string };
}

export async function loadCourseAgsContext(db: Database, courseId: string): Promise<CourseAgsContext | null> {
  const rows = await db
    .select({
      courseId: courses.id,
      institutionId: courses.institutionId,
      agsLineitemsUrl: courses.agsLineitemsUrl,
      registrationId: ltiRegistrations.id,
      registrationClientId: ltiRegistrations.clientId,
      registrationTokenEndpoint: ltiRegistrations.tokenEndpoint,
      registrationTokenAudience: ltiRegistrations.tokenAudience,
    })
    .from(courses)
    .innerJoin(institutions, eq(courses.institutionId, institutions.id))
    .innerJoin(ltiDeployments, eq(courses.deploymentId, ltiDeployments.id))
    .innerJoin(ltiRegistrations, eq(ltiDeployments.registrationId, ltiRegistrations.id))
    .where(eq(courses.id, courseId));

  const row = rows[0];
  if (!row) return null;
  return {
    courseId: row.courseId,
    institutionId: row.institutionId,
    agsLineitemsUrl: row.agsLineitemsUrl,
    registration: {
      id: row.registrationId,
      clientId: row.registrationClientId,
      tokenEndpoint: row.registrationTokenEndpoint,
      tokenAudience: row.registrationTokenAudience,
    },
  };
}
