import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
