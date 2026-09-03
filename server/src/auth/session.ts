import { randomBytes, createHash } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Database } from '../database/client.js';
import { appSessions } from '../database/schema.js';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface CreateSessionParams {
  institutionId: string;
  deploymentId: string;
  ltiSubject: string;
  displayName: string | null;
  courseId: string;
  roles: string[];
  ttlHours: number;
}

export interface CreatedSession {
  token: string;
  csrfSecret: string;
  sessionId: string;
}

export async function createSession(db: Database, params: CreateSessionParams): Promise<CreatedSession> {
  const token = randomBytes(32).toString('base64url');
  const csrfSecret = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + params.ttlHours * 60 * 60 * 1000);

  const [row] = await db
    .insert(appSessions)
    .values({
      sessionTokenHash: hashToken(token),
      institutionId: params.institutionId,
      deploymentId: params.deploymentId,
      ltiSubject: params.ltiSubject,
      displayName: params.displayName,
      courseId: params.courseId,
      roles: params.roles,
      csrfSecret,
      expiresAt,
    })
    .returning();

  return { token, csrfSecret, sessionId: row.id };
}

export interface AppSession {
  id: string;
  institutionId: string;
  deploymentId: string;
  ltiSubject: string;
  displayName: string | null;
  courseId: string;
  roles: string[];
  csrfSecret: string;
}

export async function findValidSession(db: Database, token: string): Promise<AppSession | null> {
  const tokenHash = hashToken(token);
  const rows = await db
    .select()
    .from(appSessions)
    .where(and(eq(appSessions.sessionTokenHash, tokenHash), isNull(appSessions.revokedAt), gt(appSessions.expiresAt, new Date())))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  await db.update(appSessions).set({ lastSeenAt: new Date() }).where(eq(appSessions.id, row.id));

  return {
    id: row.id,
    institutionId: row.institutionId,
    deploymentId: row.deploymentId,
    ltiSubject: row.ltiSubject,
    displayName: row.displayName,
    courseId: row.courseId,
    roles: row.roles as string[],
    csrfSecret: row.csrfSecret,
  };
}

export async function revokeSession(db: Database, sessionId: string): Promise<void> {
  await db.update(appSessions).set({ revokedAt: new Date() }).where(eq(appSessions.id, sessionId));
}
