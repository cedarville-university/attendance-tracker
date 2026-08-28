import Fastify, { type FastifyRequest } from 'fastify';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerCourseRosterRoutes } from '../../src/routes/course-roster.js';
import { RosterUnavailableError } from '../../src/attendance/roster-store.js';
import type { Database } from '../../src/database/client.js';
import type { ToolSigningKey } from '../../src/lti/signing-keys.js';

const mockGetCachedRosterAsMembers = vi.fn();
const mockGetRosterWithFallback = vi.fn();

vi.mock('../../src/attendance/roster-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/attendance/roster-store.js')>();
  return {
    ...actual, // keeps the real RosterUnavailableError + isRosterStale
    getCachedRosterAsMembers: (...a: unknown[]) => mockGetCachedRosterAsMembers(...a),
    getRosterWithFallback: (...a: unknown[]) => mockGetRosterWithFallback(...a),
  };
});

function fullMember(overrides: Record<string, unknown> = {}) {
  return {
    ltiUserId: 'u1',
    institutionalId: '001',
    displayName: 'Jane',
    givenName: null,
    familyName: null,
    email: null,
    roles: [],
    status: 'Active',
    eligibleForAttendance: true,
    ...overrides,
  };
}

function buildTestApp(opts: { authenticated?: boolean } = { authenticated: true }) {
  const app = Fastify({ logger: false });
  const auditInsert = vi.fn();
  const db = { insert: () => ({ values: auditInsert }) } as unknown as Database;
  const requireSession = async (request: FastifyRequest) => {
    if (opts.authenticated) {
      request.appSession = {
        id: 's1',
        institutionId: 'inst-1',
        deploymentId: 'dep-1',
        ltiSubject: 'sub-1',
        displayName: null,
        courseId: 'course-1',
        roles: [],
        csrfSecret: 'secret',
      };
    }
  };
  const requireCsrf = async () => {};
  registerCourseRosterRoutes(app, { db, requireSession, requireCsrf, signingKey: {} as ToolSigningKey });
  return { app, auditInsert };
}

describe('GET /api/course/roster', () => {
  beforeEach(() => {
    mockGetCachedRosterAsMembers.mockReset();
    mockGetRosterWithFallback.mockReset();
  });

  it('serves a <5-min cache without contacting Canvas and without auditing', async () => {
    mockGetCachedRosterAsMembers.mockResolvedValue({ members: [fullMember()], rosterCachedAt: new Date() });
    const { app, auditInsert } = buildTestApp();

    const res = await app.inject({ method: 'GET', url: '/api/course/roster' });

    expect(res.statusCode).toBe(200);
    expect(res.json().stale).toBe(false);
    expect(res.json().members[0]).toHaveProperty('eligibleForAttendance');
    expect(mockGetRosterWithFallback).not.toHaveBeenCalled();
    expect(auditInsert).not.toHaveBeenCalled();
  });

  it('refreshes when the cache is stale and audits the successful refresh', async () => {
    mockGetCachedRosterAsMembers.mockResolvedValue({ members: [], rosterCachedAt: new Date(Date.now() - 10 * 60 * 1000) });
    mockGetRosterWithFallback.mockResolvedValue({
      members: [fullMember()],
      fetchedAt: new Date().toISOString(),
      stale: false,
      refreshed: true,
    });
    const { app, auditInsert } = buildTestApp();

    const res = await app.inject({ method: 'GET', url: '/api/course/roster' });

    expect(res.statusCode).toBe(200);
    expect(res.json().members).toHaveLength(1);
    expect(auditInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'roster_refreshed',
        institutionId: 'inst-1',
        courseId: 'course-1',
        targetId: 'course-1',
        actorLtiUserId: 'sub-1',
      }),
    );
    expect(auditInsert.mock.calls[0][0].requestId).toBeTruthy();
  });

  it('returns the degraded cache (stale:true) without auditing when refresh fails', async () => {
    mockGetCachedRosterAsMembers.mockResolvedValue(null);
    mockGetRosterWithFallback.mockResolvedValue({
      members: [fullMember()],
      fetchedAt: new Date().toISOString(),
      stale: true,
      refreshed: false,
    });
    const { app, auditInsert } = buildTestApp();

    const res = await app.inject({ method: 'GET', url: '/api/course/roster' });

    expect(res.statusCode).toBe(200);
    expect(res.json().stale).toBe(true);
    expect(auditInsert).not.toHaveBeenCalled();
  });

  it('returns 502 when the roster is entirely unavailable', async () => {
    mockGetCachedRosterAsMembers.mockResolvedValue(null);
    mockGetRosterWithFallback.mockRejectedValue(new RosterUnavailableError('boom', 'network'));
    const { app } = buildTestApp();

    const res = await app.inject({ method: 'GET', url: '/api/course/roster' });
    expect(res.statusCode).toBe(502);
  });

  it('never collapses duplicate institutionalId members', async () => {
    mockGetCachedRosterAsMembers.mockResolvedValue(null);
    mockGetRosterWithFallback.mockResolvedValue({
      members: [fullMember({ ltiUserId: 'u1', institutionalId: 'DUP' }), fullMember({ ltiUserId: 'u2', institutionalId: 'DUP' })],
      fetchedAt: new Date().toISOString(),
      stale: false,
      refreshed: true,
    });
    const { app } = buildTestApp();

    const res = await app.inject({ method: 'GET', url: '/api/course/roster' });
    expect(res.json().members).toHaveLength(2);
  });

  it('returns 401 when no session is established', async () => {
    const { app } = buildTestApp({ authenticated: false });
    const res = await app.inject({ method: 'GET', url: '/api/course/roster' });
    expect(res.statusCode).toBe(401);
  });
});
