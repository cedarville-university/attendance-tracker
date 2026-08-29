import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { getTestDb, resetDb, closeTestDb } from '../support/db.js';
import { seedInstitutionAndCourse } from '../support/seed.js';
import { MockCanvasPlatform } from '../support/mock-canvas.js';
import { getActiveSigningKey, loadSigningKeysFromEnv, type ToolSigningKey } from '../../src/lti/signing-keys.js';
import { gradeSyncJobs, gradeLineItems, auditEvents } from '../../src/database/schema.js';
import { processGradeSyncJobs } from '../../src/attendance/grade-worker.js';

const { db } = getTestDb();
let platform: MockCanvasPlatform;
let signingKey: ToolSigningKey;
afterAll(() => closeTestDb());

beforeAll(async () => {
  platform = new MockCanvasPlatform();
  await platform.start();
  signingKey = getActiveSigningKey(await loadSigningKeysFromEnv(undefined));
});
beforeEach(async () => {
  await resetDb();
});

// A unique mock course key per test keeps the mock's per-course line-item/score maps isolated.
let agsKey = 0;
async function seedCourseWithAgs(opts: { withUrl?: boolean } = {}) {
  const key = `gw-${agsKey++}`;
  const { courseId } = await seedInstitutionAndCourse(db, platform, {
    agsLineitemsUrl: opts.withUrl === false ? null : platform.lineItemsUrlFor(key),
  });
  return { courseId, key };
}
// NOTE: claimDueJobs compares next_attempt_at against the DB clock (`sql`now()``), not the `now`
// injected into processGradeSyncJobs, so injecting a fixed `now` no longer hides a freshly-inserted
// row from the claim. The explicit `nextAttemptAt` values below are still meaningful — some assert
// retry scheduling relative to the injected `now` — so they are kept as-is.
async function insertJob(courseId: string, over: Partial<typeof gradeSyncJobs.$inferInsert>) {
  const [row] = await db.insert(gradeSyncJobs).values({ courseId, ltiUserId: 'u1', score: 100, ...over }).returning();
  return row;
}

describe('processGradeSyncJobs', () => {
  it('posts every due job, ensures the line item once, marks jobs synced, and audits grade_sync_completed', async () => {
    const { courseId, key } = await seedCourseWithAgs();
    await insertJob(courseId, { ltiUserId: 'u1', score: 100 });
    await insertJob(courseId, { ltiUserId: 'u2', score: 0 });

    const result = await processGradeSyncJobs(db, { signingKey });

    expect(result).toMatchObject({ processed: 2, synced: 2, retried: 0, failed: 0 });
    const jobs = await db.select().from(gradeSyncJobs).where(eq(gradeSyncJobs.courseId, courseId));
    expect(jobs.every((j) => j.state === 'synced')).toBe(true);

    const [li] = await db.select().from(gradeLineItems).where(eq(gradeLineItems.courseId, courseId));
    expect(li.resourceId).toBe('attendance-cumulative-v1');
    expect(platform.getLineItems(key)).toHaveLength(1);

    const posted = platform.getPostedScores(key);
    expect(posted).toHaveLength(2);
    expect(posted.map((p) => p.scoreGiven).sort()).toEqual([0, 100]);
    expect(posted[0]).toMatchObject({ scoreMaximum: 100, activityProgress: 'Completed', gradingProgress: 'FullyGraded' });

    const completed = await db.select().from(auditEvents).where(eq(auditEvents.eventType, 'grade_sync_completed'));
    expect(completed).toHaveLength(2);
    expect(completed[0]).toMatchObject({ targetType: 'grade_sync_job', actorLtiUserId: null, requestId: null });
  });

  it('reuses an existing Canvas line item instead of creating a second', async () => {
    const { courseId, key } = await seedCourseWithAgs();
    platform.seedExistingLineItem(key);
    await insertJob(courseId, { ltiUserId: 'u1', score: 50 });

    await processGradeSyncJobs(db, { signingKey });

    expect(platform.getLineItems(key)).toHaveLength(1); // no new line item
    const [li] = await db.select().from(gradeLineItems).where(eq(gradeLineItems.courseId, courseId));
    expect(li).toBeTruthy();
  });

  it('a 429 on the score post schedules a retry (pending, attempt+1, future next_attempt_at) — no failure audit', async () => {
    const { courseId } = await seedCourseWithAgs();
    const now = new Date('2026-08-28T00:00:00.000Z');
    // next_attempt_at is set in the past so the row is due; the retry assertions below are relative
    // to the injected `now`.
    const job = await insertJob(courseId, {
      ltiUserId: 'u1', score: 100, attemptCount: 0,
      nextAttemptAt: new Date(now.getTime() - 60_000),
    });
    platform.failNextScorePost('rate-limited');

    const result = await processGradeSyncJobs(db, { signingKey, now: () => now, rand: () => 0.5 });

    expect(result).toMatchObject({ processed: 1, synced: 0, retried: 1, failed: 0 });
    const [after] = await db.select().from(gradeSyncJobs).where(eq(gradeSyncJobs.id, job.id));
    expect(after.state).toBe('pending');
    expect(after.attemptCount).toBe(1);
    // First retry: computeBackoff is called with the PRE-increment attemptCount (0), so the delay
    // is GRADE_SYNC_BASE_DELAY_MS (5 min) — strictly after the injected now.
    expect(new Date(after.nextAttemptAt).getTime()).toBeGreaterThan(now.getTime());
    expect(after.lastError).toBe('ags:rate-limited');
    expect(await db.select().from(auditEvents).where(eq(auditEvents.eventType, 'grade_sync_failed'))).toHaveLength(0);
  });

  it('re-mints the AGS token once when Canvas 401s the line-items request, then succeeds', async () => {
    const { courseId, key } = await seedCourseWithAgs();
    await insertJob(courseId, { ltiUserId: 'u1', score: 100 });

    // Arm a one-shot 401 on the NEXT AGS request (the ensureLineItem GET). The worker must catch it,
    // clearAccessTokenCache + re-mint once (mirroring nrps.ts:297-300), retry ensureLineItem — which
    // now passes, one-shot consumed — and complete the score post. It must NOT fail the job.
    platform.failNextAgsRequest('auth'); // Task 5 extends failNextAgsRequest's union with 'auth' -> one-shot 401

    const result = await processGradeSyncJobs(db, { signingKey });
    expect(result).toMatchObject({ synced: 1, retried: 0, failed: 0 });
    expect(platform.getPostedScores(key)).toHaveLength(1);
    const [after] = await db.select().from(gradeSyncJobs).where(eq(gradeSyncJobs.courseId, courseId));
    expect(after.state).toBe('synced');
  });

  it('a permanent 4xx on the score post fails the job immediately and audits grade_sync_failed', async () => {
    const { courseId } = await seedCourseWithAgs();
    const job = await insertJob(courseId, { ltiUserId: 'u1', score: 100 });
    platform.failNextScorePost('client-error');

    const result = await processGradeSyncJobs(db, { signingKey });

    expect(result).toMatchObject({ synced: 0, retried: 0, failed: 1 });
    const [after] = await db.select().from(gradeSyncJobs).where(eq(gradeSyncJobs.id, job.id));
    expect(after.state).toBe('failed');
    expect(after.lastError).toBe('ags:client-error');
    const [audit] = await db.select().from(auditEvents).where(eq(auditEvents.eventType, 'grade_sync_failed'));
    expect(audit).toMatchObject({ targetType: 'grade_sync_job', targetId: job.id });
    expect(audit.newValue).toMatchObject({ ltiUserId: 'u1', error: 'ags:client-error' });
  });

  it('a retryable failure at the attempt ceiling terminally fails the job', async () => {
    const { courseId } = await seedCourseWithAgs();
    const job = await insertJob(courseId, { ltiUserId: 'u1', score: 100, attemptCount: 5 }); // MAX is 6
    platform.failNextScorePost('server-error');

    const result = await processGradeSyncJobs(db, { signingKey });

    expect(result).toMatchObject({ failed: 1, retried: 0 });
    const [after] = await db.select().from(gradeSyncJobs).where(eq(gradeSyncJobs.id, job.id));
    expect(after.state).toBe('failed');
  });

  it('fails a course whose ags_lineitems_url is missing, with ags:no-lineitems-url', async () => {
    const { courseId } = await seedCourseWithAgs({ withUrl: false });
    const job = await insertJob(courseId, { ltiUserId: 'u1', score: 100 });

    const result = await processGradeSyncJobs(db, { signingKey });

    expect(result).toMatchObject({ failed: 1 });
    const [after] = await db.select().from(gradeSyncJobs).where(eq(gradeSyncJobs.id, job.id));
    expect(after).toMatchObject({ state: 'failed', lastError: 'ags:no-lineitems-url' });
    expect(await db.select().from(auditEvents).where(eq(auditEvents.eventType, 'grade_sync_failed'))).toHaveLength(1);
  });

  it('does not claim a job whose next_attempt_at is in the future', async () => {
    const { courseId } = await seedCourseWithAgs();
    await insertJob(courseId, { ltiUserId: 'u1', score: 100, nextAttemptAt: new Date(Date.now() + 3_600_000) });

    const result = await processGradeSyncJobs(db, { signingKey });
    expect(result).toMatchObject({ processed: 0, synced: 0 });
  });
});
