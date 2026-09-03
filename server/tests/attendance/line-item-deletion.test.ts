import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { getTestDb, resetDb, closeTestDb } from '../support/db.js';
import { seedInstitutionAndCourse } from '../support/seed.js';
import { MockCanvasPlatform } from '../support/mock-canvas.js';
import { getActiveSigningKey, loadSigningKeysFromEnv, type ToolSigningKey } from '../../src/lti/signing-keys.js';
import { auditEvents, gradeLineItems, gradeSyncJobs } from '../../src/database/schema.js';
import {
  requestLineItemDeletion,
  cancelLineItemDeletion,
  claimDueLineItemDeletions,
  markLineItemDeletionRetry,
  markLineItemDeletionFailed,
  rearmLineItemDeletion,
  deleteGradeLineItemRow,
  countStuckLineItemDeletions,
} from '../../src/attendance/line-item-deletion-store.js';
import { deleteCourseGradeSyncJobs } from '../../src/attendance/grade-sync-store.js';
import { processLineItemDeletions } from '../../src/attendance/line-item-deletion.js';

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

  it('countStuckLineItemDeletions counts only requested rows with a null delete_next_attempt_at', async () => {
    const stuck = await seedCourse();
    const backingOff = await seedCourse();
    const noRequest = await seedCourse();
    await seedLineItem(stuck.courseId, { deleteRequestedAt: new Date(), deleteNextAttemptAt: null, deleteLastError: 'ags:server-error' });
    await seedLineItem(backingOff.courseId, { deleteRequestedAt: new Date(), deleteNextAttemptAt: new Date(Date.now() + 60_000) });
    await seedLineItem(noRequest.courseId, { deleteRequestedAt: null, deleteNextAttemptAt: null });

    expect(await countStuckLineItemDeletions(db)).toBe(1);
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

describe('processLineItemDeletions', () => {
  let agsKey = 0;
  // Seed a course whose AGS URL points at an isolated mock course key, plus a persisted line item
  // with a real mock line-item URL, already flagged as a due deletion request.
  async function seedDueDeletion(over: Partial<typeof gradeLineItems.$inferInsert> = {}) {
    const key = `lid-${agsKey++}`;
    // Vary client_id — seedInstitutionAndCourse inserts an lti_registrations row with
    // UNIQUE(issuer, client_id), so cases that seed more than one course would collide.
    const { courseId } = await seedInstitutionAndCourse(db, platform, {
      clientId: `client-${randomUUID()}`,
      agsLineitemsUrl: platform.lineItemsUrlFor(key),
    });
    const canvasLineItemUrl = platform.seedExistingLineItem(key);
    const canvasLineItemId = canvasLineItemUrl.split('/').pop()!;
    await db.insert(gradeLineItems).values({
      courseId,
      canvasLineItemId,
      canvasLineItemUrl,
      resourceId: 'attendance-cumulative-v1',
      tag: 'attendance',
      scoreMaximum: 100,
      deleteRequestedAt: new Date(Date.now() - 60_000),
      deleteRequestedByLtiUserId: 'i1',
      deleteNextAttemptAt: new Date(Date.now() - 60_000),
      ...over,
    });
    return { courseId, key, canvasLineItemId };
  }

  it('DELETEs the Canvas line item, removes the grade_line_items row, audits grade_line_item_deleted', async () => {
    const { courseId, key, canvasLineItemId } = await seedDueDeletion();

    const result = await processLineItemDeletions(db, { signingKey });

    expect(result).toMatchObject({ processed: 1, deleted: 1, retried: 0, failed: 0 });
    expect(platform.getLineItems(key)).toHaveLength(0);
    expect(await db.select().from(gradeLineItems).where(eq(gradeLineItems.courseId, courseId))).toHaveLength(0);
    const [audit] = await db.select().from(auditEvents).where(eq(auditEvents.eventType, 'grade_line_item_deleted'));
    expect(audit).toMatchObject({ targetType: 'grade_line_item', targetId: courseId, actorLtiUserId: null });
    expect(audit.newValue).toMatchObject({ canvasLineItemId, canvas404: false });
  });

  it('treats a Canvas 404 as success (row removed, canvas404 true)', async () => {
    const { courseId } = await seedDueDeletion();
    // Repoint at a well-formed line-item URL on the live mock that was never created -> DELETE 404.
    const mockBase = platform.lineItemsUrlFor('x').replace(/\/ags\/x\/lineitems$/, '');
    await db
      .update(gradeLineItems)
      .set({ canvasLineItemUrl: `${mockBase}/ags/lineitems/never-created`, canvasLineItemId: 'never-created' })
      .where(eq(gradeLineItems.courseId, courseId));

    const result = await processLineItemDeletions(db, { signingKey });

    expect(result).toMatchObject({ processed: 1, deleted: 1, failed: 0 });
    expect(await db.select().from(gradeLineItems).where(eq(gradeLineItems.courseId, courseId))).toHaveLength(0);
    const [audit] = await db.select().from(auditEvents).where(eq(auditEvents.eventType, 'grade_line_item_deleted'));
    expect(audit.newValue).toMatchObject({ canvas404: true });
  });

  it('a 429 schedules a retry: attempt+1, future delete_next_attempt_at, row kept, no failure audit', async () => {
    const { courseId } = await seedDueDeletion();
    const now = new Date('2026-09-01T00:00:00.000Z');
    platform.failNextAgsRequest('rate-limited');

    const result = await processLineItemDeletions(db, { signingKey, now: () => now, rand: () => 0.5 });

    expect(result).toMatchObject({ processed: 1, deleted: 0, retried: 1, failed: 0 });
    const [row] = await db.select().from(gradeLineItems).where(eq(gradeLineItems.courseId, courseId));
    expect(row.deleteAttemptCount).toBe(1);
    expect(row.deleteRequestedAt).not.toBeNull();
    expect(new Date(row.deleteNextAttemptAt!).getTime()).toBeGreaterThan(now.getTime());
    expect(row.deleteLastError).toBe('ags:rate-limited');
    expect(await db.select().from(auditEvents).where(eq(auditEvents.eventType, 'grade_line_item_delete_failed'))).toHaveLength(0);
  });

  it('at the attempt ceiling a retryable failure is terminal: delete_next_attempt_at NULL + grade_line_item_delete_failed', async () => {
    const { courseId } = await seedDueDeletion({ deleteAttemptCount: 5 }); // MAX_GRADE_SYNC_ATTEMPTS - 1
    platform.failNextAgsRequest('server-error');

    const result = await processLineItemDeletions(db, { signingKey });

    expect(result).toMatchObject({ processed: 1, deleted: 0, retried: 0, failed: 1 });
    const [row] = await db.select().from(gradeLineItems).where(eq(gradeLineItems.courseId, courseId));
    expect(row.deleteRequestedAt).not.toBeNull();
    expect(row.deleteNextAttemptAt).toBeNull();
    expect(row.deleteLastError).toBe('ags:server-error');
    const [audit] = await db.select().from(auditEvents).where(eq(auditEvents.eventType, 'grade_line_item_delete_failed'));
    expect(audit.newValue).toMatchObject({ attemptCount: 6, error: 'ags:server-error' });
  });

  it('a permanent 4xx is terminal on the first attempt', async () => {
    const { courseId } = await seedDueDeletion();
    platform.failNextAgsRequest('client-error');

    const result = await processLineItemDeletions(db, { signingKey });

    expect(result).toMatchObject({ deleted: 0, retried: 0, failed: 1 });
    const [row] = await db.select().from(gradeLineItems).where(eq(gradeLineItems.courseId, courseId));
    expect(row.deleteNextAttemptAt).toBeNull();
    expect(row.deleteLastError).toBe('ags:client-error');
  });

  it('a 401 is re-minted once and then succeeds', async () => {
    const { courseId, key } = await seedDueDeletion();
    platform.failNextAgsRequest('auth'); // one-shot 401

    const result = await processLineItemDeletions(db, { signingKey });

    expect(result.deleted).toBe(1);
    expect(platform.getLineItems(key)).toHaveLength(0);
    void courseId;
  });

  it('if the request is cleared between the AGS call and the finalize, the row is kept and not counted', async () => {
    const { courseId, key } = await seedDueDeletion();
    // fetchImpl clears the deletion request right after the DELETE resolves, simulating a
    // concurrent close/restore winning the race.
    const realFetch = fetch;
    const raceFetch: typeof fetch = async (input, init) => {
      const res = await realFetch(input as string, init);
      if ((init?.method ?? 'GET') === 'DELETE') {
        await db.update(gradeLineItems)
          .set({ deleteRequestedAt: null, deleteRequestedByLtiUserId: null, deleteAttemptCount: 0, deleteNextAttemptAt: null, deleteLastError: null })
          .where(eq(gradeLineItems.courseId, courseId));
      }
      return res;
    };

    const result = await processLineItemDeletions(db, { signingKey, fetchImpl: raceFetch });

    expect(result).toMatchObject({ processed: 1, deleted: 0, retried: 0, failed: 0 });
    // Canvas line item was deleted, but the local row survives because the request was cleared.
    expect(platform.getLineItems(key)).toHaveLength(0);
    expect(await db.select().from(gradeLineItems).where(eq(gradeLineItems.courseId, courseId))).toHaveLength(1);
    expect(await db.select().from(auditEvents).where(eq(auditEvents.eventType, 'grade_line_item_deleted'))).toHaveLength(0);
  });

  it('if the row is repointed at a different line item between the AGS call and the finalize, the row survives with its new identity and is not counted', async () => {
    const { courseId, key } = await seedDueDeletion();
    // fetchImpl repoints the row at a different Canvas line item right after the DELETE resolves --
    // e.g. a cancel + recompute (recreating the line item) + a fresh removal request, all racing the
    // in-flight DELETE -- while leaving deleteRequestedAt set, simulating the identity-mismatch race.
    const realFetch = fetch;
    const raceFetch: typeof fetch = async (input, init) => {
      const res = await realFetch(input as string, init);
      if ((init?.method ?? 'GET') === 'DELETE') {
        await db.update(gradeLineItems)
          .set({ canvasLineItemId: 'li-B', canvasLineItemUrl: 'https://canvas.example.edu/api/lti/courses/1/line_items/li-B' })
          .where(eq(gradeLineItems.courseId, courseId));
      }
      return res;
    };

    const result = await processLineItemDeletions(db, { signingKey, fetchImpl: raceFetch });

    expect(result).toMatchObject({ processed: 1, deleted: 0, retried: 0, failed: 0 });
    // Canvas line item A was deleted, but the local row survives -- now naming line item B, untouched.
    expect(platform.getLineItems(key)).toHaveLength(0);
    const rows = await db.select().from(gradeLineItems).where(eq(gradeLineItems.courseId, courseId));
    expect(rows).toHaveLength(1);
    expect(rows[0].canvasLineItemId).toBe('li-B');
    expect(rows[0].canvasLineItemUrl).toBe('https://canvas.example.edu/api/lti/courses/1/line_items/li-B');
    expect(rows[0].deleteRequestedAt).not.toBeNull();
    expect(await db.select().from(auditEvents).where(eq(auditEvents.eventType, 'grade_line_item_deleted'))).toHaveLength(0);
  });

  it('stops between rows when shouldStop() flips', async () => {
    await seedDueDeletion();
    await seedDueDeletion();
    let calls = 0;
    const result = await processLineItemDeletions(db, {
      signingKey,
      shouldStop: () => calls++ >= 1, // false for the first row, true before the second
    });
    expect(result.processed).toBe(1);
  });
});
