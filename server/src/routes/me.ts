import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { eq } from 'drizzle-orm';
import type { Database } from '../database/client.js';
import { institutions, courses } from '../database/schema.js';

export interface MeRouteDeps {
  requireSession: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  db: Database;
}

export function registerMeRoute(app: FastifyInstance, deps: MeRouteDeps): void {
  app.get('/api/me', { preHandler: deps.requireSession }, async (request: FastifyRequest, reply: FastifyReply) => {
    const session = request.appSession;
    if (!session) {
      return reply.code(401).send({ error: 'unauthenticated' });
    }

    const [institution] = await deps.db.select().from(institutions).where(eq(institutions.id, session.institutionId)).limit(1);
    const [course] = await deps.db.select().from(courses).where(eq(courses.id, session.courseId)).limit(1);

    return {
      user: { displayName: session.displayName ?? session.ltiSubject, roles: session.roles },
      institution: { name: institution?.displayName ?? '' },
      course: { id: course?.id ?? '', label: course?.label ?? '', title: course?.title ?? '' },
      permissions: { takeAttendance: true, editAttendance: true },
      csrfToken: session.csrfSecret,
    };
  });
}
