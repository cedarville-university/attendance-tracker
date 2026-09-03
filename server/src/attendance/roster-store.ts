//
// Persists the Canvas roster fetched by lti/nrps.ts into course_members. A row that drops off the
// roster is marked status: 'removed', never deleted, so a Phase 5 attendance_session_members snapshot
// holding a course_members.id never dangles. Also owns the shared getRosterWithFallback degradation
// helper (Task 12).

import { and, eq, inArray } from 'drizzle-orm';
import type { Database } from '../database/client.js';
import { courseMembers, courses, institutions } from '../database/schema.js';
import type { CourseRosterMember } from '../lti/nrps.js';
import { refreshCourseRoster } from '../lti/nrps.js';
import { resolveInstitutionRosterConfig, isEligibleForAttendance } from '../lti/roster-config.js';
import type { ToolSigningKey } from '../lti/signing-keys.js';

export type CourseMemberRow = typeof courseMembers.$inferSelect;

export interface UpsertRosterSummary {
  added: number;
  removed: number;
  stillPresent: number;
}

export async function upsertCourseMembers(
  db: Database,
  courseId: string,
  members: CourseRosterMember[],
): Promise<UpsertRosterSummary> {
  return db.transaction(async (tx) => {
    const existing = await tx.select().from(courseMembers).where(eq(courseMembers.courseId, courseId));
    const existingIds = new Set(existing.map((r) => r.ltiUserId));
    const freshIds = new Set(members.map((m) => m.ltiUserId));

    let added = 0;
    let stillPresent = 0;

    for (const m of members) {
      if (existingIds.has(m.ltiUserId)) stillPresent += 1;
      else added += 1;

      const values = {
        institutionalId: m.institutionalId,
        displayName: m.displayName,
        givenName: m.givenName,
        familyName: m.familyName,
        email: m.email,
        roles: m.roles,
        status: m.status,
        lastSeenAt: new Date(),
      };
      await tx
        .insert(courseMembers)
        .values({ courseId, ltiUserId: m.ltiUserId, ...values })
        .onConflictDoUpdate({ target: [courseMembers.courseId, courseMembers.ltiUserId], set: values });
    }

    const dropped = existing
      .filter((r) => !freshIds.has(r.ltiUserId) && r.status !== 'removed')
      .map((r) => r.ltiUserId);
    if (dropped.length > 0) {
      await tx
        .update(courseMembers)
        .set({ status: 'removed', lastSeenAt: new Date() })
        .where(and(eq(courseMembers.courseId, courseId), inArray(courseMembers.ltiUserId, dropped)));
    }

    await tx.update(courses).set({ rosterCachedAt: new Date() }).where(eq(courses.id, courseId));

    return { added, removed: dropped.length, stillPresent };
  });
}

const ROSTER_CACHE_TTL_MS = 5 * 60 * 1000; // spec §18.4

export function isRosterStale(rosterCachedAt: Date | null, nowMs: number = Date.now()): boolean {
  if (rosterCachedAt === null) return true;
  return nowMs - rosterCachedAt.getTime() > ROSTER_CACHE_TTL_MS;
}

export async function getCachedRoster(
  db: Database,
  courseId: string,
): Promise<{ members: CourseMemberRow[]; rosterCachedAt: Date | null } | null> {
  const [course] = await db.select().from(courses).where(eq(courses.id, courseId));
  if (!course) return null;
  const members = await db.select().from(courseMembers).where(eq(courseMembers.courseId, courseId));
  return { members, rosterCachedAt: course.rosterCachedAt };
}

export async function findCourseMembersByInstitutionalId(
  db: Database,
  courseId: string,
  institutionalId: string,
): Promise<CourseMemberRow[]> {
  return db
    .select()
    .from(courseMembers)
    .where(and(eq(courseMembers.courseId, courseId), eq(courseMembers.institutionalId, institutionalId)));
}

async function resolveLearnerRoles(db: Database, courseId: string): Promise<string[]> {
  const [row] = await db
    .select({
      canvasIdentityMatchField: institutions.canvasIdentityMatchField,
      identityMatchEmailEnabled: institutions.identityMatchEmailEnabled,
      rosterLearnerRoles: institutions.rosterLearnerRoles,
    })
    .from(courses)
    .innerJoin(institutions, eq(courses.institutionId, institutions.id))
    .where(eq(courses.id, courseId));
  return row ? resolveInstitutionRosterConfig(row).rosterLearnerRoles : ['Learner'];
}

// Single converter used by EVERY cache-read path so eligibleForAttendance is always present and always
// computed the same way (spec §25.2 "normalized members" -- one shape regardless of cache age).
export function cachedRowToMember(row: CourseMemberRow, learnerRoles: string[]): CourseRosterMember {
  const roles = (row.roles as string[]) ?? [];
  return {
    ltiUserId: row.ltiUserId,
    institutionalId: row.institutionalId,
    displayName: row.displayName,
    givenName: row.givenName,
    familyName: row.familyName,
    email: row.email,
    roles,
    status: row.status,
    eligibleForAttendance: isEligibleForAttendance(row.status, roles, learnerRoles),
  };
}

export async function getCachedRosterAsMembers(
  db: Database,
  courseId: string,
): Promise<{ members: CourseRosterMember[]; rosterCachedAt: Date | null } | null> {
  const cached = await getCachedRoster(db, courseId);
  if (!cached) return null;
  const learnerRoles = await resolveLearnerRoles(db, courseId);
  return {
    members: cached.members.filter((m) => m.status !== 'removed').map((m) => cachedRowToMember(m, learnerRoles)),
    rosterCachedAt: cached.rosterCachedAt,
  };
}

export const STALE_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export class RosterUnavailableError extends Error {
  readonly kind: string;
  constructor(message: string, kind: string) {
    super(message);
    this.name = 'RosterUnavailableError';
    this.kind = kind;
  }
}

export interface RosterWithFallback {
  members: CourseRosterMember[];
  fetchedAt: string;
  stale: boolean;
  refreshed: boolean;
}

export interface GetRosterWithFallbackDeps {
  signingKey: ToolSigningKey;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  now?: () => number;
}

export async function getRosterWithFallback(
  db: Database,
  courseId: string,
  deps: GetRosterWithFallbackDeps,
): Promise<RosterWithFallback> {
  const now = deps.now ?? Date.now;

  const fresh = await refreshCourseRoster(db, courseId, {
    signingKey: deps.signingKey,
    fetchImpl: deps.fetchImpl,
    sleepImpl: deps.sleepImpl,
  });
  if (fresh.ok) {
    return { members: fresh.members, fetchedAt: fresh.fetchedAt, stale: false, refreshed: true };
  }

  const cached = await getCachedRosterAsMembers(db, courseId);
  if (cached && cached.rosterCachedAt && now() - cached.rosterCachedAt.getTime() < STALE_CACHE_MAX_AGE_MS) {
    return {
      members: cached.members,
      fetchedAt: cached.rosterCachedAt.toISOString(),
      stale: true,
      refreshed: false,
    };
  }

  throw new RosterUnavailableError(fresh.error.message, fresh.error.kind);
}
