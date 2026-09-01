import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { getTestDb, resetDb, closeTestDb } from '../support/db.js';
import { seedInstitutionAndCourse } from '../support/seed.js';
import { MockCanvasPlatform } from '../support/mock-canvas.js';
import { gradeSyncJobs } from '../../src/database/schema.js';
import {
  MAX_GRADE_SYNC_ATTEMPTS,
  GRADE_SYNC_BASE_DELAY_MS,
  GRADE_SYNC_MAX_DELAY_MS,
  computeBackoff,
  upsertGradeSyncJobs,
  claimDueJobs,
  markJobSynced,
  markJobRetry,
  markJobFailed,
  getGradeSyncSummary,
  resetFailedJobs,
} from '../../src/attendance/grade-sync-store.js';

const { db } = getTestDb();
const platform = new MockCanvasPlatform();
afterAll(() => closeTestDb());
beforeEach(async () => {
  await resetDb();
});

async function seedSessionAndCourse() {
  const { courseId } = await seedInstitutionAndCourse(db, platform, { agsLineitemsUrl: platform.lineItemsUrlFor('c') });
  const { attendanceSessions } = await import('../../src/database/schema.js');
  const [session] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'i1', state: 'closed' }).returning();
  return { courseId, sessionId: session.id };
}

describe('computeBackoff', () => {
  const now = new Date('2026-08-28T00:00:00.000Z');
  it('grows exponentially from the 5-minute base and is capped at 1 hour', () => {
    const noJitter = () => 0.5; // 0.5 -> zero jitter (see impl: (rand*2 - 1))
    expect(computeBackoff(0, now, noJitter).getTime() - now.getTime()).toBe(GRADE_SYNC_BASE_DELAY_MS);
    expect(computeBackoff(1, now, noJitter).getTime() - now.getTime()).toBe(GRADE_SYNC_BASE_DELAY_MS * 2);
    expect(computeBackoff(2, now, noJitter).getTime() - now.getTime()).toBe(GRADE_SYNC_BASE_DELAY_MS * 4);
    // 5min * 2^10 would be ~85h -> capped
    expect(computeBackoff(10, now, noJitter).getTime() - now.getTime()).toBe(GRADE_SYNC_MAX_DELAY_MS);
  });
  it('exposes the retry ceiling as a constant', () => {
    expect(MAX_GRADE_SYNC_ATTEMPTS).toBe(6);
  });
  it('applies at most +/-20% jitter and never schedules in the past', () => {
    for (const r of [0, 1, 0.5, 0.9, 0.1]) {
      const delta = computeBackoff(1, now, () => r).getTime() - now.getTime();
      const base = GRADE_SYNC_BASE_DELAY_MS * 2;
      expect(delta).toBeGreaterThanOrEqual(base * 0.8 - 1);
      expect(delta).toBeLessThanOrEqual(base * 1.2 + 1);
      expect(delta).toBeGreaterThan(0);
    }
  });
});

describe('upsertGradeSyncJobs', () => {
  it('inserts one pending job per member, then UPDATES the same row on the next close (UNIQUE course+member)', async () => {
    const { courseId, sessionId } = await seedSessionAndCourse();
    const first = await upsertGradeSyncJobs(db, courseId, sessionId, new Map([['u1', { scoreGiven: 40 }], ['u2', { scoreGiven: 100 }]]));
    expect(first).toBe(2);
    let rows = await db.select().from(gradeSyncJobs).where(eq(gradeSyncJobs.courseId, courseId));
    expect(rows).toHaveLength(2);

    // simulate a prior failure on u1, then a re-close with a new score
    await markJobFailed(db, rows.find((r) => r.ltiUserId === 'u1')!.id, 'ags:client-error', new Date());
    const second = await upsertGradeSyncJobs(db, courseId, sessionId, new Map([['u1', { scoreGiven: 55 }], ['u2', { scoreGiven: 100 }]]));
    expect(second).toBe(2);
    rows = await db.select().from(gradeSyncJobs).where(eq(gradeSyncJobs.courseId, courseId));
    expect(rows).toHaveLength(2); // still 2 — upserted, not appended
    const u1 = rows.find((r) => r.ltiUserId === 'u1')!;
    expect(u1.score).toBeCloseTo(55);
    expect(u1.state).toBe('pending'); // reset from failed
    expect(u1.attemptCount).toBe(0);
    expect(u1.lastError).toBeNull();
  });

  it('accepts a transaction executor', async () => {
    const { courseId, sessionId } = await seedSessionAndCourse();
    await db.transaction(async (tx) => {
      await upsertGradeSyncJobs(tx, courseId, sessionId, new Map([['u1', { scoreGiven: 10 }]]));
    });
    const rows = await db.select().from(gradeSyncJobs).where(eq(gradeSyncJobs.courseId, courseId));
    expect(rows).toHaveLength(1);
  });
});

describe('claimDueJobs / markJob*', () => {
  it('claims only pending jobs whose next_attempt_at is due (DB clock), oldest first, up to the limit', async () => {
    const { courseId, sessionId } = await seedSessionAndCourse();
    await upsertGradeSyncJobs(db, courseId, sessionId, new Map([['u1', { scoreGiven: 10 }], ['u2', { scoreGiven: 20 }], ['u3', { scoreGiven: 30 }]]));
    const rows = await db.select().from(gradeSyncJobs).where(eq(gradeSyncJobs.courseId, courseId));
    // push u3's next_attempt_at into the future — the due-check must exclude it
    await markJobRetry(db, rows.find((r) => r.ltiUserId === 'u3')!.id, 1, new Date(Date.now() + 3_600_000), 'ags:rate-limited', new Date());
    // mark u2 synced — not pending, must be excluded
    await markJobSynced(db, rows.find((r) => r.ltiUserId === 'u2')!.id, new Date());

    // claimDueJobs compares next_attempt_at against the DB clock, so no `now` argument is passed.
    const due = await claimDueJobs(db, 10);
    expect(due.map((j) => j.ltiUserId)).toEqual(['u1']);
  });
});

describe('getGradeSyncSummary', () => {
  it('reports none / pending / failed precedence and the latest failed error', async () => {
    const { courseId, sessionId } = await seedSessionAndCourse();
    expect(await getGradeSyncSummary(db, courseId)).toMatchObject({ state: 'none', counts: { pending: 0, synced: 0, failed: 0 } });

    await upsertGradeSyncJobs(db, courseId, sessionId, new Map([['u1', { scoreGiven: 10 }], ['u2', { scoreGiven: 20 }]]));
    expect((await getGradeSyncSummary(db, courseId)).state).toBe('pending');

    const rows = await db.select().from(gradeSyncJobs).where(eq(gradeSyncJobs.courseId, courseId));
    await markJobSynced(db, rows[0].id, new Date());
    await markJobFailed(db, rows[1].id, 'ags:client-error', new Date());
    const summary = await getGradeSyncSummary(db, courseId);
    expect(summary.state).toBe('failed'); // failed outranks synced
    expect(summary.counts).toEqual({ pending: 0, synced: 1, failed: 1 });
    expect(summary.lastError).toBe('ags:client-error');
  });

  it('reports total, the earliest pending next_attempt_at, and the latest synced updated_at', async () => {
    const { courseId, sessionId } = await seedSessionAndCourse();
    await upsertGradeSyncJobs(
      db,
      courseId,
      sessionId,
      new Map([['u1', { scoreGiven: 10 }], ['u2', { scoreGiven: 20 }], ['u3', { scoreGiven: 30 }]]),
    );
    const rows = await db.select().from(gradeSyncJobs).where(eq(gradeSyncJobs.courseId, courseId));
    const u = (id: string) => rows.find((r) => r.ltiUserId === id)!;

    // u1 synced earlier, u2 synced later; u3 pending with a far-future next attempt.
    const early = new Date('2026-08-28T10:00:00.000Z');
    const late = new Date('2026-08-28T11:30:00.000Z');
    const future = new Date('2026-08-28T12:00:00.000Z');
    await markJobSynced(db, u('u1').id, early);
    await markJobSynced(db, u('u2').id, late);
    await markJobRetry(db, u('u3').id, 1, future, 'ags:rate-limited', late);

    const summary = await getGradeSyncSummary(db, courseId);
    expect(summary.total).toBe(3);
    expect(summary.nextAttemptAt).toBe(future.toISOString());
    expect(summary.lastSyncedAt).toBe(late.toISOString());
  });

  it('nulls nextAttemptAt when nothing is pending and lastSyncedAt when nothing is synced', async () => {
    const { courseId, sessionId } = await seedSessionAndCourse();
    await upsertGradeSyncJobs(db, courseId, sessionId, new Map([['u1', { scoreGiven: 10 }]]));
    const [row] = await db.select().from(gradeSyncJobs).where(eq(gradeSyncJobs.courseId, courseId));

    // All pending, none synced.
    let summary = await getGradeSyncSummary(db, courseId);
    expect(summary.nextAttemptAt).not.toBeNull();
    expect(summary.lastSyncedAt).toBeNull();

    await markJobFailed(db, row.id, 'ags:client-error', new Date());
    summary = await getGradeSyncSummary(db, courseId);
    expect(summary.nextAttemptAt).toBeNull();
    expect(summary.lastSyncedAt).toBeNull();
  });
});

describe('resetFailedJobs', () => {
  it('flips only failed jobs back to pending with a cleared error and attempt count', async () => {
    const { courseId, sessionId } = await seedSessionAndCourse();
    await upsertGradeSyncJobs(db, courseId, sessionId, new Map([['u1', { scoreGiven: 10 }], ['u2', { scoreGiven: 20 }]]));
    const rows = await db.select().from(gradeSyncJobs).where(eq(gradeSyncJobs.courseId, courseId));
    await markJobFailed(db, rows[0].id, 'ags:server-error', new Date());
    await markJobSynced(db, rows[1].id, new Date());

    const count = await resetFailedJobs(db, courseId, new Date());
    expect(count).toBe(1);
    const after = await db.select().from(gradeSyncJobs).where(and(eq(gradeSyncJobs.courseId, courseId), eq(gradeSyncJobs.ltiUserId, 'u1')));
    expect(after[0]).toMatchObject({ state: 'pending', attemptCount: 0, lastError: null });
  });
});
