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
