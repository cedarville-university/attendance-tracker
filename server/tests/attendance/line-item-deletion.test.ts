import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { getTestDb, resetDb, closeTestDb } from '../support/db.js';
import { seedInstitutionAndCourse } from '../support/seed.js';
import { MockCanvasPlatform } from '../support/mock-canvas.js';
import { gradeLineItems, gradeSyncJobs } from '../../src/database/schema.js';
import {
  requestLineItemDeletion,
  cancelLineItemDeletion,
  claimDueLineItemDeletions,
  markLineItemDeletionRetry,
  markLineItemDeletionFailed,
  rearmLineItemDeletion,
  deleteGradeLineItemRow,
} from '../../src/attendance/line-item-deletion-store.js';
import { deleteCourseGradeSyncJobs } from '../../src/attendance/grade-sync-store.js';

const { db } = getTestDb();
const platform = new MockCanvasPlatform();
afterAll(() => closeTestDb());
beforeEach(async () => {
  await resetDb();
});

// Each seedInstitutionAndCourse call inserts an lti_registrations row with UNIQUE(issuer, client_id);
// tests that seed more than one course per case must vary client_id or they collide.
function seedCourse() {
  return seedInstitutionAndCourse(db, platform, { clientId: `client-${randomUUID()}` });
}

async function seedLineItem(courseId: string, over: Partial<typeof gradeLineItems.$inferInsert> = {}) {
  const [row] = await db
    .insert(gradeLineItems)
    .values({
      courseId,
      canvasLineItemId: 'li-1',
      canvasLineItemUrl: 'https://canvas.example.edu/api/lti/courses/1/line_items/li-1',
      resourceId: 'attendance-cumulative-v1',
      tag: 'attendance',
      scoreMaximum: 100,
      ...over,
    })
    .returning();
  return row;
}

describe('line-item-deletion-store', () => {
  it('requestLineItemDeletion sets the request on an existing row and reports the canvas id', async () => {
    const { courseId } = await seedInstitutionAndCourse(db, platform);
    await seedLineItem(courseId);
    const now = new Date('2026-09-01T00:00:00.000Z');

    const res = await requestLineItemDeletion(db, courseId, 'instructor-9', now);

    expect(res).toEqual({ requested: true, canvasLineItemId: 'li-1' });
    const [row] = await db.select().from(gradeLineItems).where(eq(gradeLineItems.courseId, courseId));
    expect(row.deleteRequestedAt).not.toBeNull();
    expect(row.deleteRequestedByLtiUserId).toBe('instructor-9');
    expect(row.deleteAttemptCount).toBe(0);
    expect(row.deleteNextAttemptAt).not.toBeNull();
    expect(row.deleteLastError).toBeNull();
  });

  it('requestLineItemDeletion reports requested:false when no row exists', async () => {
    const { courseId } = await seedInstitutionAndCourse(db, platform);
    const res = await requestLineItemDeletion(db, courseId, 'i1', new Date());
    expect(res).toEqual({ requested: false, canvasLineItemId: null });
  });

  it('cancelLineItemDeletion clears all delete_* fields and reports whether it touched a row', async () => {
    const { courseId } = await seedInstitutionAndCourse(db, platform);
    await seedLineItem(courseId, {
      deleteRequestedAt: new Date(),
      deleteRequestedByLtiUserId: 'i1',
      deleteAttemptCount: 3,
      deleteNextAttemptAt: new Date(),
      deleteLastError: 'ags:server-error',
    });

    expect(await cancelLineItemDeletion(db, courseId)).toBe(true);
    const [row] = await db.select().from(gradeLineItems).where(eq(gradeLineItems.courseId, courseId));
    expect(row.deleteRequestedAt).toBeNull();
    expect(row.deleteRequestedByLtiUserId).toBeNull();
    expect(row.deleteAttemptCount).toBe(0);
    expect(row.deleteNextAttemptAt).toBeNull();
    expect(row.deleteLastError).toBeNull();

    expect(await cancelLineItemDeletion(db, courseId)).toBe(false); // nothing left to cancel
  });

  it('claimDueLineItemDeletions returns only due requested rows, oldest-scheduled first', async () => {
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 600_000);
    const c1 = await seedCourse();
    const c2 = await seedCourse();
    const c3 = await seedCourse();
    const c4 = await seedCourse();
    await seedLineItem(c1.courseId, { deleteRequestedAt: past, deleteNextAttemptAt: new Date(past.getTime() - 1000) });
    await seedLineItem(c2.courseId, { deleteRequestedAt: past, deleteNextAttemptAt: past });
    await seedLineItem(c3.courseId, { deleteRequestedAt: past, deleteNextAttemptAt: future }); // backing off
    await seedLineItem(c4.courseId, { deleteRequestedAt: null, deleteNextAttemptAt: null }); // no request

    const due = await claimDueLineItemDeletions(db, 50);

    expect(due.map((r) => r.courseId)).toEqual([c1.courseId, c2.courseId]);
  });

  it('markLineItemDeletionRetry bumps the count and schedules the next attempt', async () => {
    const { courseId } = await seedInstitutionAndCourse(db, platform);
    await seedLineItem(courseId, { deleteRequestedAt: new Date(), deleteNextAttemptAt: new Date() });
    const next = new Date(Date.now() + 300_000);

    await markLineItemDeletionRetry(db, courseId, 1, next, 'ags:rate-limited', new Date());

    const [row] = await db.select().from(gradeLineItems).where(eq(gradeLineItems.courseId, courseId));
    expect(row.deleteAttemptCount).toBe(1);
    expect(row.deleteLastError).toBe('ags:rate-limited');
    expect(new Date(row.deleteNextAttemptAt!).getTime()).toBe(next.getTime());
    expect(row.deleteRequestedAt).not.toBeNull();
  });

  it('markLineItemDeletionFailed keeps the request but nulls the schedule', async () => {
    const { courseId } = await seedInstitutionAndCourse(db, platform);
    await seedLineItem(courseId, { deleteRequestedAt: new Date(), deleteNextAttemptAt: new Date(), deleteAttemptCount: 6 });

    await markLineItemDeletionFailed(db, courseId, 'ags:server-error', new Date());

    const [row] = await db.select().from(gradeLineItems).where(eq(gradeLineItems.courseId, courseId));
    expect(row.deleteRequestedAt).not.toBeNull();
    expect(row.deleteNextAttemptAt).toBeNull();
    expect(row.deleteLastError).toBe('ags:server-error');
  });

  it('rearmLineItemDeletion reschedules a terminally-failed request only', async () => {
    const stuck = await seedCourse();
    const healthy = await seedCourse();
    await seedLineItem(stuck.courseId, { deleteRequestedAt: new Date(), deleteNextAttemptAt: null, deleteAttemptCount: 6, deleteLastError: 'ags:server-error' });
    await seedLineItem(healthy.courseId, { deleteRequestedAt: new Date(), deleteNextAttemptAt: new Date() });

    expect(await rearmLineItemDeletion(db, stuck.courseId, new Date())).toBe(true);
    expect(await rearmLineItemDeletion(db, healthy.courseId, new Date())).toBe(false); // still scheduled, not stuck

    const [row] = await db.select().from(gradeLineItems).where(eq(gradeLineItems.courseId, stuck.courseId));
    expect(row.deleteAttemptCount).toBe(0);
    expect(row.deleteNextAttemptAt).not.toBeNull();
  });

  it('deleteGradeLineItemRow removes the course row', async () => {
    const { courseId } = await seedInstitutionAndCourse(db, platform);
    await seedLineItem(courseId);
    await deleteGradeLineItemRow(db, courseId);
    expect(await db.select().from(gradeLineItems).where(eq(gradeLineItems.courseId, courseId))).toHaveLength(0);
  });

  it('deleteCourseGradeSyncJobs removes every job for the course and returns the count', async () => {
    const a = await seedCourse();
    const b = await seedCourse();
    await db.insert(gradeSyncJobs).values([
      { courseId: a.courseId, ltiUserId: 'u1', score: 10, state: 'pending' },
      { courseId: a.courseId, ltiUserId: 'u2', score: 20, state: 'synced' },
      { courseId: b.courseId, ltiUserId: 'u1', score: 30, state: 'pending' },
    ]);

    const removed = await deleteCourseGradeSyncJobs(db, a.courseId);

    expect(removed).toBe(2);
    expect(await db.select().from(gradeSyncJobs).where(eq(gradeSyncJobs.courseId, a.courseId))).toHaveLength(0);
    expect(await db.select().from(gradeSyncJobs).where(eq(gradeSyncJobs.courseId, b.courseId))).toHaveLength(1);
  });
});
