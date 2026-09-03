import { vi, describe, it, expect, beforeEach } from 'vitest';
import { fetchCourseRoster, refreshCourseRoster, buildMemberIndex, countEligible } from '../course-roster.js';
import { bootstrapSession } from '../api-client.js';

beforeEach(() => {
  global.fetch = vi.fn();
});

const MEMBER = {
  ltiUserId: 'u-1',
  institutionalId: '0041234',
  displayName: 'Test Learner',
  givenName: 'Test',
  familyName: 'Learner',
  email: null,
  roles: ['http://purl.imsglobal.org/vocab/lis/v2/membership#Learner'],
  status: 'Active',
  eligibleForAttendance: true,
};

describe('fetchCourseRoster', () => {
  it('GETs /api/course/roster and returns the normalized member list', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ members: [MEMBER], fetchedAt: '2026-08-31T19:00:00.000Z', stale: false }),
    });

    const result = await fetchCourseRoster();

    expect(global.fetch).toHaveBeenCalledWith('/api/course/roster', expect.objectContaining({ method: 'GET' }));
    expect(result).toEqual({ ok: true, members: [MEMBER], fetchedAt: '2026-08-31T19:00:00.000Z', stale: false });
  });

  it('returns a normalized error (never throws) on a 502 roster_refresh_failed, carrying the status', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: () => Promise.resolve({ error: 'roster_refresh_failed', requestId: 'r-1' }),
    });

    const result = await fetchCourseRoster();

    expect(result.ok).toBe(false);
    expect(result.error.kind).toBe('http-status');
    expect(result.error.status).toBe(502);
  });

  it('returns a network error result when fetch rejects', async () => {
    global.fetch.mockRejectedValueOnce(new Error('offline'));
    const result = await fetchCourseRoster();
    expect(result).toEqual({ ok: false, error: { kind: 'network', message: expect.stringContaining('offline') } });
  });
});

describe('refreshCourseRoster', () => {
  it('POSTs /api/course/roster/refresh with the CSRF token and no body', async () => {
    global.fetch.mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ csrfToken: 'tok-9' }) });
    await bootstrapSession();
    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ members: [], fetchedAt: '2026-08-31T19:05:00.000Z', stale: false }),
    });

    const result = await refreshCourseRoster();

    const [url, init] = global.fetch.mock.calls.at(-1);
    expect(url).toBe('/api/course/roster/refresh');
    expect(init.method).toBe('POST');
    expect(init.headers['x-csrf-token']).toBe('tok-9');
    expect(init.body).toBeUndefined();
    expect(result.ok).toBe(true);
  });
});

describe('buildMemberIndex', () => {
  it('keys eligible members by normalized institutional ID and skips members with no ID', () => {
    const noId = { ...MEMBER, ltiUserId: 'u-2', institutionalId: null };
    const ineligible = { ...MEMBER, ltiUserId: 'u-3', institutionalId: '9', eligibleForAttendance: false };
    const index = buildMemberIndex([MEMBER, noId, ineligible]);
    expect([...index.keys()]).toEqual(['0041234']);
    expect(index.get('0041234').ltiUserId).toBe('u-1');
  });
});

describe('countEligible', () => {
  it('counts only members eligible for attendance', () => {
    expect(countEligible([MEMBER, { ...MEMBER, eligibleForAttendance: false }])).toBe(1);
  });
});
