// GET /api/course/roster, POST /api/course/roster/refresh (spec §25.2). Both return normalized
// CourseRosterMember-shaped members (never a raw NRPS payload), one shape regardless of cache age.
// Both degrade to a <24h cache with stale:true rather than hard-failing (a transient Canvas 429 must
// not block an instructor mid-class). A successful live refresh writes a roster_refreshed audit row
// (spec §33) carrying request.id as the correlation id (spec §31.9).

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Database } from '../database/client.js';
import type { AppSession } from '../auth/session.js';
import type { ToolSigningKey } from '../lti/signing-keys.js';
import { auditEvents } from '../database/schema.js';
import {
  getCachedRosterAsMembers,
  getRosterWithFallback,
  isRosterStale,
  RosterUnavailableError,
} from '../attendance/roster-store.js';
import type { CourseRosterMember } from '../lti/nrps.js';

export interface CourseRosterRouteDeps {
  db: Database;
  requireSession: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  requireCsrf: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  signingKey: ToolSigningKey;
}

function serializeMember(m: CourseRosterMember) {
  return {
    ltiUserId: m.ltiUserId,
    institutionalId: m.institutionalId,
    displayName: m.displayName,
    givenName: m.givenName,
    familyName: m.familyName,
    email: m.email,
    roles: m.roles,
    status: m.status,
    eligibleForAttendance: m.eligibleForAttendance,
  };
}

async function writeRosterRefreshedAuditEvent(
  db: Database,
  session: AppSession,
  memberCount: number,
  requestId: string,
): Promise<void> {
  await db.insert(auditEvents).values({
    institutionId: session.institutionId,
    courseId: session.courseId,
    actorLtiUserId: session.ltiSubject,
    eventType: 'roster_refreshed',
    targetType: 'course',
    targetId: session.courseId,
    newValue: { memberCount },
    requestId,
  });
}

export function registerCourseRosterRoutes(app: FastifyInstance, deps: CourseRosterRouteDeps): void {
  app.get('/api/course/roster', { preHandler: deps.requireSession }, async (request, reply) => {
    const session = request.appSession;
    if (!session) {
      return reply.code(401).send({ error: 'unauthenticated' });
    }

    const cached = await getCachedRosterAsMembers(deps.db, session.courseId);
    if (cached && !isRosterStale(cached.rosterCachedAt)) {
      return {
        members: cached.members.map(serializeMember),
        fetchedAt: cached.rosterCachedAt!.toISOString(),
        stale: false,
      };
    }

    try {
      const roster = await getRosterWithFallback(deps.db, session.courseId, { signingKey: deps.signingKey });
      if (roster.refreshed) {
        await writeRosterRefreshedAuditEvent(deps.db, session, roster.members.length, request.id);
      }
      return { members: roster.members.map(serializeMember), fetchedAt: roster.fetchedAt, stale: roster.stale };
    } catch (err) {
      if (err instanceof RosterUnavailableError) {
        return reply.code(502).send({ error: 'roster_refresh_failed', message: err.message });
      }
      throw err;
    }
  });

  app.post(
    '/api/course/roster/refresh',
    { preHandler: [deps.requireSession, deps.requireCsrf] },
    async (request, reply) => {
      const session = request.appSession;
      if (!session) {
        return reply.code(401).send({ error: 'unauthenticated' });
      }

      try {
        const roster = await getRosterWithFallback(deps.db, session.courseId, { signingKey: deps.signingKey });
        if (roster.refreshed) {
          await writeRosterRefreshedAuditEvent(deps.db, session, roster.members.length, request.id);
        }
        return { members: roster.members.map(serializeMember), fetchedAt: roster.fetchedAt, stale: roster.stale };
      } catch (err) {
        if (err instanceof RosterUnavailableError) {
          return reply.code(502).send({ error: 'roster_refresh_failed', message: err.message });
        }
        throw err;
      }
    },
  );
}
