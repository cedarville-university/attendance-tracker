import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { fetchRawMembershipPages } from '../../src/lti/nrps.js';
import { MockCanvasPlatform } from '../support/mock-canvas.js';

async function mintToken(platform: MockCanvasPlatform): Promise<string> {
  const res = await fetch(platform.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: 'mock-assertion',
      scope: 'https://purl.imsglobal.org/spec/lti-nrps/scope/contextmembership.readonly',
    }).toString(),
  });
  return ((await res.json()) as { access_token: string }).access_token;
}

describe('fetchRawMembershipPages', () => {
  let platform: MockCanvasPlatform;

  beforeAll(async () => {
    platform = new MockCanvasPlatform();
    await platform.start();
  });
  afterAll(async () => {
    await platform.stop();
  });

  it('follows Link-header pagination across multiple pages', async () => {
    platform.setCourseMembers('course-multi', [
      { user_id: 'u1', status: 'Active', roles: [] },
      { user_id: 'u2', status: 'Active', roles: [] },
      { user_id: 'u3', status: 'Active', roles: [] },
    ]);
    platform.setPageSize(1);
    const token = await mintToken(platform);

    const result = await fetchRawMembershipPages(platform.nrpsUrlFor('course-multi'), token);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.members.map((m) => m.user_id)).toEqual(['u1', 'u2', 'u3']);
    }
  });

  it('reports a pagination-failure when a LATER page has no members array', async () => {
    platform.setCourseMembers('course-p2break', [
      { user_id: 'u1', status: 'Active', roles: [] },
      { user_id: 'u2', status: 'Active', roles: [] },
    ]);
    platform.setPageSize(1);
    platform.breakPaginationOnNextPage('course-p2break'); // page >= 2 returns a body with no `members`
    const token = await mintToken(platform);

    const result = await fetchRawMembershipPages(platform.nrpsUrlFor('course-p2break'), token);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('pagination-failure');
      expect(result.error.retryable).toBe(false);
    }
  });

  it('reports expired-token on a 401', async () => {
    platform.setCourseMembers('course-expired', [{ user_id: 'u1', status: 'Active', roles: [] }]);
    const token = await mintToken(platform);
    platform.expireAccessToken(token);

    const result = await fetchRawMembershipPages(platform.nrpsUrlFor('course-expired'), token);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('expired-token');
      expect(result.error.retryable).toBe(true);
    }
  });

  it('reports rate-limited with the Retry-After value on a 429', async () => {
    platform.setCourseMembers('course-429', [{ user_id: 'u1', status: 'Active', roles: [] }]);
    const token = await mintToken(platform);
    platform.rateLimitNextRequest('course-429');

    const result = await fetchRawMembershipPages(platform.nrpsUrlFor('course-429'), token);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('rate-limited');
      expect(result.error.retryAfterSeconds).toBe(1);
    }
  });
});

import { normalizeMember } from '../../src/lti/nrps.js';
import type { InstitutionRosterConfig } from '../../src/lti/roster-config.js';

describe('normalizeMember', () => {
  const config: InstitutionRosterConfig = {
    canvasIdentityMatchField: 'lis_person_sourcedid',
    identityMatchEmailEnabled: false,
    rosterLearnerRoles: ['Learner'],
  };
  const learnerRole = 'http://purl.imsglobal.org/vocab/lis/v2/membership#Learner';
  const instructorRole = 'http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor';

  it('normalizes an active learner as eligible', () => {
    const raw = {
      user_id: 'u1',
      status: 'Active',
      roles: [learnerRole],
      name: 'Jane Student',
      given_name: 'Jane',
      family_name: 'Student',
      email: 'jane@example.edu',
      lis_person_sourcedid: '001234',
    };
    expect(normalizeMember(raw, config)).toEqual({
      ltiUserId: 'u1',
      institutionalId: '001234',
      displayName: 'Jane Student',
      givenName: 'Jane',
      familyName: 'Student',
      email: 'jane@example.edu',
      roles: [learnerRole],
      status: 'Active',
      eligibleForAttendance: true,
    });
  });

  it('normalizes an inactive learner as ineligible', () => {
    expect(normalizeMember({ user_id: 'u2', status: 'Inactive', roles: [learnerRole] }, config).eligibleForAttendance).toBe(false);
  });

  it('excludes an instructor from eligibility', () => {
    expect(normalizeMember({ user_id: 'u3', status: 'Active', roles: [instructorRole] }, config).eligibleForAttendance).toBe(false);
  });

  it('honors a custom configured learner role', () => {
    const customConfig: InstitutionRosterConfig = { ...config, rosterLearnerRoles: ['Learner', 'ProxyLearner'] };
    const raw = { user_id: 'u4', status: 'Active', roles: ['http://purl.imsglobal.org/vocab/lis/v2/membership#ProxyLearner'] };
    expect(normalizeMember(raw, customConfig).eligibleForAttendance).toBe(true);
  });

  it('leaves institutionalId null when the SIS ID field is missing', () => {
    expect(normalizeMember({ user_id: 'u5', status: 'Active', roles: [learnerRole] }, config).institutionalId).toBeNull();
  });

  it('normalizes two members sharing the same institutionalId independently (no dedup)', () => {
    const a = normalizeMember({ user_id: 'u6', status: 'Active', roles: [learnerRole], lis_person_sourcedid: 'DUP1' }, config);
    const b = normalizeMember({ user_id: 'u7', status: 'Active', roles: [learnerRole], lis_person_sourcedid: 'DUP1' }, config);
    expect(a.institutionalId).toBe('DUP1');
    expect(b.institutionalId).toBe('DUP1');
    expect(a.ltiUserId).not.toBe(b.ltiUserId);
  });
});

import { refreshCourseRoster } from '../../src/lti/nrps.js';
import { eq } from 'drizzle-orm';
import { getTestDb, resetDb, closeTestDb } from '../support/db.js';
import { seedInstitutionAndCourse } from '../support/seed.js';
import { loadSigningKeysFromEnv, getActiveSigningKey, type ToolSigningKey } from '../../src/lti/signing-keys.js';
import { courseMembers } from '../../src/database/schema.js';

// This file already has a MockCanvasPlatform in an outer describe; the refresh suite uses its own so
// the two lifecycles stay independent. Close the shared pg pool once, at file scope.
afterAll(async () => {
  await closeTestDb();
});

describe('refreshCourseRoster', () => {
  let platform: MockCanvasPlatform;
  let signingKey: ToolSigningKey;

  beforeAll(async () => {
    platform = new MockCanvasPlatform();
    await platform.start();
    // Exercises the REAL getActiveSigningKey(keys) -- synchronous, takes the loaded array.
    signingKey = getActiveSigningKey(await loadSigningKeysFromEnv(undefined));
  });
  afterAll(async () => {
    await platform.stop();
  });
  beforeEach(async () => {
    await resetDb();
  });

  it('fetches, normalizes, and persists the roster (mock serves plain http)', async () => {
    const { db } = getTestDb();
    const { courseId } = await seedInstitutionAndCourse(db, platform, { nrpsUrl: platform.nrpsUrlFor('course-a') });
    platform.setCourseMembers('course-a', [
      { user_id: 'u1', status: 'Active', roles: ['http://purl.imsglobal.org/vocab/lis/v2/membership#Learner'], lis_person_sourcedid: '001' },
    ]);
    platform.setPageSize(1);

    const result = await refreshCourseRoster(db, courseId, { signingKey, sleepImpl: async () => {} });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.members).toHaveLength(1);
      expect(result.members[0].institutionalId).toBe('001');
    }
    expect(await db.select().from(courseMembers).where(eq(courseMembers.courseId, courseId))).toHaveLength(1);
  });

  it('retries once after clearing the token cache on an expired token, then succeeds', async () => {
    const { db } = getTestDb();
    const { courseId } = await seedInstitutionAndCourse(db, platform, { nrpsUrl: platform.nrpsUrlFor('course-b') });
    platform.setCourseMembers('course-b', [{ user_id: 'u1', status: 'Active', roles: [] }]);

    const first = await refreshCourseRoster(db, courseId, { signingKey, sleepImpl: async () => {} });
    expect(first.ok).toBe(true);

    // Capture the token our cache is now holding via a spying fetchImpl, expire exactly that token on
    // the mock, then refresh again -- refreshCourseRoster clears its cache on the 401 and re-auths.
    let captured: string | undefined;
    const spyFetch: typeof fetch = async (input, init) => {
      const auth = new Headers(init?.headers).get('authorization');
      if (auth?.startsWith('Bearer ') && typeof input === 'string' && input.includes('/nrps/')) {
        captured = auth.slice('Bearer '.length);
      }
      return fetch(input as string, init);
    };
    await refreshCourseRoster(db, courseId, { signingKey, fetchImpl: spyFetch, sleepImpl: async () => {} });
    expect(captured).toBeDefined();

    platform.expireAccessToken(captured!);
    const retried = await refreshCourseRoster(db, courseId, { signingKey, sleepImpl: async () => {} });
    expect(retried.ok).toBe(true);
  });

  it('retries after a 429, honoring Retry-After, then succeeds', async () => {
    const { db } = getTestDb();
    const { courseId } = await seedInstitutionAndCourse(db, platform, { nrpsUrl: platform.nrpsUrlFor('course-c') });
    platform.setCourseMembers('course-c', [{ user_id: 'u1', status: 'Active', roles: [] }]);
    platform.rateLimitNextRequest('course-c');

    const result = await refreshCourseRoster(db, courseId, { signingKey, sleepImpl: async () => {} });
    expect(result.ok).toBe(true);
  });

  it('fails with invalid-service-url when the course has no nrpsUrl', async () => {
    const { db } = getTestDb();
    const { courseId } = await seedInstitutionAndCourse(db, platform, { nrpsUrl: null });

    const result = await refreshCourseRoster(db, courseId, { signingKey, sleepImpl: async () => {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('invalid-service-url');
  });

  it('returns a non-throwing network error when token acquisition fails', async () => {
    const { db } = getTestDb();
    const { courseId } = await seedInstitutionAndCourse(db, platform, { nrpsUrl: platform.nrpsUrlFor('course-d') });
    const deadFetch: typeof fetch = async () => {
      throw new Error('connect ECONNREFUSED');
    };
    const result = await refreshCourseRoster(db, courseId, { signingKey, fetchImpl: deadFetch, sleepImpl: async () => {} });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('network');
      expect(result.error.retryable).toBe(true);
    }
  });
});
