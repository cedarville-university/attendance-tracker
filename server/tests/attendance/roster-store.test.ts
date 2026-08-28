import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest';
import { getTestDb, resetDb, closeTestDb } from '../support/db.js';
import { seedInstitutionAndCourse } from '../support/seed.js';
import { MockCanvasPlatform } from '../support/mock-canvas.js';
import { courses, courseMembers } from '../../src/database/schema.js';
import {
  upsertCourseMembers,
  isRosterStale,
  getCachedRoster,
  getCachedRosterAsMembers,
  findCourseMembersByInstitutionalId,
  getRosterWithFallback,
  RosterUnavailableError,
  STALE_CACHE_MAX_AGE_MS,
} from '../../src/attendance/roster-store.js';
import type { CourseRosterMember } from '../../src/lti/nrps.js';
import { loadSigningKeysFromEnv, getActiveSigningKey, type ToolSigningKey } from '../../src/lti/signing-keys.js';

let platform: MockCanvasPlatform;

beforeAll(async () => {
  platform = new MockCanvasPlatform();
  await platform.start();
});
afterAll(async () => {
  await platform.stop();
  await closeTestDb();
});

function member(overrides: Partial<CourseRosterMember> & { ltiUserId: string }): CourseRosterMember {
  return {
    institutionalId: null,
    displayName: null,
    givenName: null,
    familyName: null,
    email: null,
    roles: [],
    status: 'Active',
    eligibleForAttendance: true,
    ...overrides,
  };
}

describe('upsertCourseMembers', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('adds new members, marks dropped members removed (not deleted), keeps still-present members', async () => {
    const { db } = getTestDb();
    const { courseId } = await seedInstitutionAndCourse(db, platform);

    expect(await upsertCourseMembers(db, courseId, [
      member({ ltiUserId: 'u1', institutionalId: '001' }),
      member({ ltiUserId: 'u2', institutionalId: '002' }),
    ])).toEqual({ added: 2, removed: 0, stillPresent: 0 });

    expect(await upsertCourseMembers(db, courseId, [
      member({ ltiUserId: 'u1', institutionalId: '001' }),
      member({ ltiUserId: 'u3', institutionalId: '003' }),
    ])).toEqual({ added: 1, removed: 1, stillPresent: 1 });

    const rows = await db.select().from(courseMembers).where(eq(courseMembers.courseId, courseId));
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.ltiUserId === 'u2')?.status).toBe('removed');
    expect(rows.find((r) => r.ltiUserId === 'u1')?.status).toBe('Active');
  });

  it('persists an attribute change on a still-present member (spec §46 "changed roster")', async () => {
    const { db } = getTestDb();
    const { courseId } = await seedInstitutionAndCourse(db, platform);
    await upsertCourseMembers(db, courseId, [member({ ltiUserId: 'u1', displayName: 'Old Name' })]);

    const summary = await upsertCourseMembers(db, courseId, [member({ ltiUserId: 'u1', displayName: 'New Name' })]);
    expect(summary).toEqual({ added: 0, removed: 0, stillPresent: 1 });

    const [row] = await db.select().from(courseMembers).where(eq(courseMembers.courseId, courseId));
    expect(row.displayName).toBe('New Name');
  });

  it('re-activates a previously-removed member that reappears', async () => {
    const { db } = getTestDb();
    const { courseId } = await seedInstitutionAndCourse(db, platform);
    await upsertCourseMembers(db, courseId, [member({ ltiUserId: 'u1' })]);
    await upsertCourseMembers(db, courseId, []); // u1 dropped -> status 'removed'
    await upsertCourseMembers(db, courseId, [member({ ltiUserId: 'u1', status: 'Active' })]);

    const [row] = await db.select().from(courseMembers).where(eq(courseMembers.courseId, courseId));
    expect(row.status).toBe('Active');
  });

  it('updates courses.rosterCachedAt on every call', async () => {
    const { db } = getTestDb();
    const { courseId } = await seedInstitutionAndCourse(db, platform);
    const before = Date.now();
    await upsertCourseMembers(db, courseId, [member({ ltiUserId: 'u1' })]);
    const [course] = await db.select().from(courses).where(eq(courses.id, courseId));
    expect(course.rosterCachedAt).not.toBeNull();
    expect(course.rosterCachedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });
});

describe('isRosterStale', () => {
  it('is stale when there is no cached timestamp', () => {
    expect(isRosterStale(null)).toBe(true);
  });
  it('is not stale within the 5-minute TTL', () => {
    const now = Date.now();
    expect(isRosterStale(new Date(now - 4 * 60 * 1000), now)).toBe(false);
  });
  it('is stale past the 5-minute TTL', () => {
    const now = Date.now();
    expect(isRosterStale(new Date(now - 6 * 60 * 1000), now)).toBe(true);
  });
});

describe('getCachedRoster / getCachedRosterAsMembers', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns null for a course with no row', async () => {
    const { db } = getTestDb();
    expect(await getCachedRoster(db, '00000000-0000-0000-0000-000000000000')).toBeNull();
    expect(await getCachedRosterAsMembers(db, '00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  it('getCachedRosterAsMembers recomputes eligibleForAttendance on every row and excludes removed', async () => {
    const { db } = getTestDb();
    const { courseId } = await seedInstitutionAndCourse(db, platform);
    await upsertCourseMembers(db, courseId, [
      member({ ltiUserId: 'u1', roles: ['http://purl.imsglobal.org/vocab/lis/v2/membership#Learner'], status: 'Active' }),
      member({ ltiUserId: 'u2', roles: ['http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor'], status: 'Active' }),
    ]);
    await upsertCourseMembers(db, courseId, [
      member({ ltiUserId: 'u1', roles: ['http://purl.imsglobal.org/vocab/lis/v2/membership#Learner'], status: 'Active' }),
    ]); // u2 dropped

    const cached = await getCachedRosterAsMembers(db, courseId);
    expect(cached).not.toBeNull();
    expect(cached!.members).toHaveLength(1);
    expect(cached!.members[0]).toMatchObject({ ltiUserId: 'u1', eligibleForAttendance: true });
    expect(cached!.members[0]).toHaveProperty('eligibleForAttendance');
  });
});

describe('findCourseMembersByInstitutionalId', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns every member sharing an institutionalId, never merging or dropping duplicates', async () => {
    const { db } = getTestDb();
    const { courseId } = await seedInstitutionAndCourse(db, platform);
    await upsertCourseMembers(db, courseId, [
      member({ ltiUserId: 'u1', institutionalId: 'DUP1' }),
      member({ ltiUserId: 'u2', institutionalId: 'DUP1' }),
      member({ ltiUserId: 'u3', institutionalId: 'UNIQUE' }),
    ]);

    expect((await findCourseMembersByInstitutionalId(db, courseId, 'DUP1')).map((m) => m.ltiUserId).sort()).toEqual(['u1', 'u2']);
    expect(await findCourseMembersByInstitutionalId(db, courseId, 'UNIQUE')).toHaveLength(1);
    expect(await findCourseMembersByInstitutionalId(db, courseId, 'NOPE')).toHaveLength(0);
  });
});

describe('getRosterWithFallback', () => {
  let signingKey: ToolSigningKey;

  beforeAll(async () => {
    signingKey = getActiveSigningKey(await loadSigningKeysFromEnv(undefined));
  });
  beforeEach(async () => {
    await resetDb();
  });

  it('exports a 24h ceiling', () => {
    expect(STALE_CACHE_MAX_AGE_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('returns a fresh roster with refreshed:true on a successful Canvas fetch', async () => {
    const { db } = getTestDb();
    const { courseId } = await seedInstitutionAndCourse(db, platform, { nrpsUrl: platform.nrpsUrlFor('gw-fresh') });
    platform.setCourseMembers('gw-fresh', [
      { user_id: 'u1', status: 'Active', roles: ['http://purl.imsglobal.org/vocab/lis/v2/membership#Learner'] },
    ]);

    const result = await getRosterWithFallback(db, courseId, { signingKey, sleepImpl: async () => {} });
    expect(result).toMatchObject({ stale: false, refreshed: true });
    expect(result.members[0]).toHaveProperty('eligibleForAttendance', true);
  });

  it('falls back to a <24h cache with stale:true when the fresh fetch fails', async () => {
    const { db } = getTestDb();
    const { courseId } = await seedInstitutionAndCourse(db, platform, { nrpsUrl: platform.nrpsUrlFor('gw-stale') });
    platform.setCourseMembers('gw-stale', [
      { user_id: 'u1', status: 'Active', roles: ['http://purl.imsglobal.org/vocab/lis/v2/membership#Learner'] },
      { user_id: 'u2', status: 'Active', roles: ['http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor'] },
    ]);
    // Populate the cache with a real refresh, then break Canvas.
    await getRosterWithFallback(db, courseId, { signingKey, sleepImpl: async () => {} });
    const dead: typeof fetch = async () => {
      throw new Error('ECONNREFUSED');
    };

    const result = await getRosterWithFallback(db, courseId, { signingKey, fetchImpl: dead, sleepImpl: async () => {} });
    expect(result).toMatchObject({ stale: true, refreshed: false });
    expect(result.members).toHaveLength(2);
    // SG3 shape parity: same keys as the fresh path.
    const fresh = await getRosterWithFallback(db, courseId, { signingKey, sleepImpl: async () => {} });
    expect(Object.keys(result.members[0]).sort()).toEqual(Object.keys(fresh.members[0]).sort());
  });

  it('throws RosterUnavailableError when the fetch fails and there is no cache', async () => {
    const { db } = getTestDb();
    const { courseId } = await seedInstitutionAndCourse(db, platform, { nrpsUrl: platform.nrpsUrlFor('gw-none') });
    const dead: typeof fetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    await expect(getRosterWithFallback(db, courseId, { signingKey, fetchImpl: dead, sleepImpl: async () => {} })).rejects.toBeInstanceOf(
      RosterUnavailableError,
    );
  });

  it('throws RosterUnavailableError when the fetch fails and the cache is older than 24h', async () => {
    const { db } = getTestDb();
    const { courseId } = await seedInstitutionAndCourse(db, platform, { nrpsUrl: platform.nrpsUrlFor('gw-25h') });
    platform.setCourseMembers('gw-25h', [{ user_id: 'u1', status: 'Active', roles: [] }]);
    await getRosterWithFallback(db, courseId, { signingKey, sleepImpl: async () => {} });
    // Age the cache to 25 hours.
    await db.update(courses).set({ rosterCachedAt: new Date(Date.now() - 25 * 60 * 60 * 1000) }).where(eq(courses.id, courseId));
    const dead: typeof fetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    await expect(getRosterWithFallback(db, courseId, { signingKey, fetchImpl: dead, sleepImpl: async () => {} })).rejects.toBeInstanceOf(
      RosterUnavailableError,
    );
  });
});
