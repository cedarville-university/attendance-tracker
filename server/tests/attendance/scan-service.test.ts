import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { getTestDb, resetDb, closeTestDb } from '../support/db.js';
import { seedInstitutionAndCourse } from '../support/seed.js';
import { MockCanvasPlatform } from '../support/mock-canvas.js';
import { submitScan } from '../../src/attendance/scan-service.js';
import { and, eq } from 'drizzle-orm';
import { attendanceSessions, attendanceSessionMembers, attendanceRecords } from '../../src/database/schema.js';
import type { IdentityResolver, IdentityResolution } from '../../src/identity/types.js';

const { db } = getTestDb();
// Seeding reads only platform.issuer / platform.jwksUri — no .start() needed (scan-service
// never contacts Canvas; the roster snapshot is written directly in these tests).
const platform = new MockCanvasPlatform();
afterAll(() => closeTestDb());

beforeEach(async () => {
  await resetDb();
});

function successResolution(overrides: Partial<IdentityResolution> = {}): IdentityResolution {
  return { ok: true, universityId: '1000000', firstName: 'Jane', lastName: 'Smith', email: 'jane@example.edu', raw: {}, error: null, ...overrides };
}

async function seedOpenSessionWithMember(institutionalId = '1000000') {
  const { institutionId, courseId } = await seedInstitutionAndCourse(db, platform);
  const [session] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'instructor-1', state: 'open' }).returning();
  await db.insert(attendanceSessionMembers).values({
    attendanceSessionId: session.id,
    ltiUserId: 'user-1',
    institutionalId,
    displayName: 'Jane Smith',
    eligibleForAttendance: true,
    status: 'Active',
    snapshotData: {},
  });
  return { institutionId, sessionId: session.id };
}

describe('submitScan', () => {
  it('creates a present record for a card that resolves to exactly one roster-snapshot member', async () => {
    const { institutionId, sessionId } = await seedOpenSessionWithMember('1000000');
    const resolver: IdentityResolver = { resolveCard: async () => successResolution({ universityId: '1000000' }) };

    const record = await submitScan(
      db,
      sessionId,
      { clientScanId: 'scan-1', cardCode: 'CARD001', scannedAt: new Date().toISOString() },
      { resolver, institution: { id: institutionId, cardFingerprintEnabled: false } }
    );

    expect(record.status).toBe('present');
    expect(record.ltiUserId).toBe('user-1');
    expect(record.institutionalId).toBe('1000000');
    expect(record.source).toBe('card');
    expect(record.cardFingerprint).toBeNull();
    expect(record.attendanceSessionId).toBe(sessionId);
  });

  it('never persists the raw card code anywhere on the returned record', async () => {
    const { institutionId, sessionId } = await seedOpenSessionWithMember('1000000');
    const resolver: IdentityResolver = { resolveCard: async () => successResolution({ universityId: '1000000' }) };

    const record = await submitScan(
      db,
      sessionId,
      { clientScanId: 'scan-1', cardCode: 'SUPERSECRETCARD42', scannedAt: new Date().toISOString() },
      { resolver, institution: { id: institutionId, cardFingerprintEnabled: false } }
    );

    expect(JSON.stringify(record)).not.toContain('SUPERSECRETCARD42');
  });

  it('computes and stores a card fingerprint (never the raw code) when the institution enables it', async () => {
    const { institutionId, sessionId } = await seedOpenSessionWithMember('1000000');
    const resolver: IdentityResolver = { resolveCard: async () => successResolution({ universityId: '1000000' }) };

    const record = await submitScan(
      db,
      sessionId,
      { clientScanId: 'scan-1', cardCode: 'CARD001', scannedAt: new Date().toISOString() },
      { resolver, institution: { id: institutionId, cardFingerprintEnabled: true } }
    );

    expect(record.cardFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('records a lookup_error with lookupErrorKind=missing-university-id when the resolver returns ok:true but universityId:null (spec §20, Q6)', async () => {
    const { institutionId, sessionId } = await seedOpenSessionWithMember('1000000');
    const resolver: IdentityResolver = { resolveCard: async () => successResolution({ universityId: null }) };

    const record = await submitScan(
      db,
      sessionId,
      { clientScanId: 'scan-1', cardCode: 'CARD001', scannedAt: new Date().toISOString() },
      { resolver, institution: { id: institutionId, cardFingerprintEnabled: false } }
    );

    expect(record.status).toBe('lookup_error');
    expect(record.lookupErrorKind).toBe('missing-university-id');
    expect(record.ltiUserId).toBeNull();
  });

  it('rejects scan submission with a 409-mapped error when the session is closed', async () => {
    const { institutionId, courseId } = await seedInstitutionAndCourse(db, platform);
    const [session] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'instructor-1', state: 'closed' }).returning();
    const resolver: IdentityResolver = { resolveCard: async () => successResolution() };

    await expect(
      submitScan(db, session.id, { clientScanId: 'scan-1', cardCode: 'CARD001', scannedAt: new Date().toISOString() }, { resolver, institution: { id: institutionId, cardFingerprintEnabled: false } })
    ).rejects.toMatchObject({ code: 'session_closed' });
  });
});

describe('submitScan -- roster matching edge cases', () => {
  it('marks a resolved identity not present in the session snapshot as unexpected, not present', async () => {
    const { institutionId, sessionId } = await seedOpenSessionWithMember('1000000'); // only 1000000 is on the roster
    const resolver: IdentityResolver = { resolveCard: async () => successResolution({ universityId: '9999999' }) };

    const record = await submitScan(db, sessionId, { clientScanId: 'scan-1', cardCode: 'CARD999', scannedAt: new Date().toISOString() }, { resolver, institution: { id: institutionId, cardFingerprintEnabled: false } });

    expect(record.status).toBe('unexpected');
    expect(record.ltiUserId).toBeNull();
    expect(record.institutionalId).toBe('9999999');
  });

  it('marks an ambiguous match (duplicate institutionalId in the snapshot) as unexpected, never present', async () => {
    const { institutionId, courseId } = await seedInstitutionAndCourse(db, platform);
    const [session] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'instructor-1', state: 'open' }).returning();
    await db.insert(attendanceSessionMembers).values([
      { attendanceSessionId: session.id, ltiUserId: 'user-1', institutionalId: '1000000', displayName: 'Jane A', eligibleForAttendance: true, status: 'Active', snapshotData: {} },
      { attendanceSessionId: session.id, ltiUserId: 'user-2', institutionalId: '1000000', displayName: 'Jane B', eligibleForAttendance: true, status: 'Active', snapshotData: {} },
    ]);
    const resolver: IdentityResolver = { resolveCard: async () => successResolution({ universityId: '1000000' }) };

    const record = await submitScan(db, session.id, { clientScanId: 'scan-1', cardCode: 'CARD001', scannedAt: new Date().toISOString() }, { resolver, institution: { id: institutionId, cardFingerprintEnabled: false } });

    expect(record.status).toBe('unexpected');
    expect(record.ltiUserId).toBeNull();
  });

  it('records a lookup_error status (with lookupErrorKind) when the resolver fails, rather than dropping the scan', async () => {
    const { institutionId, sessionId } = await seedOpenSessionWithMember();
    const resolver: IdentityResolver = { resolveCard: async () => ({ ok: false, universityId: null, firstName: null, lastName: null, email: null, raw: null, error: { kind: 'timeout', message: 'Lookup timed out' } }) };

    const record = await submitScan(db, sessionId, { clientScanId: 'scan-1', cardCode: 'CARD001', scannedAt: new Date().toISOString() }, { resolver, institution: { id: institutionId, cardFingerprintEnabled: false } });

    expect(record.status).toBe('lookup_error');
    expect(record.lookupErrorKind).toBe('timeout');
    expect(record.ltiUserId).toBeNull();
    expect(record.institutionalId).toBeNull();
  });

  it('re-resolves a prior lookup_error on retry (same clientScanId) and updates the SAME row to present — no dead end (spec §47, B6)', async () => {
    const { institutionId, sessionId } = await seedOpenSessionWithMember('1000000');
    let attempt = 0;
    const resolver: IdentityResolver = {
      resolveCard: async () => {
        attempt += 1;
        return attempt === 1
          ? { ok: false, universityId: null, firstName: null, lastName: null, email: null, raw: null, error: { kind: 'timeout', message: 'down' } }
          : successResolution({ universityId: '1000000' });
      },
    };
    const input = { clientScanId: 'retry-1', cardCode: 'CARD001', scannedAt: new Date().toISOString() };
    const deps = { resolver, institution: { id: institutionId, cardFingerprintEnabled: false } };

    const first = await submitScan(db, sessionId, input, deps);
    expect(first.status).toBe('lookup_error');

    const second = await submitScan(db, sessionId, input, deps);
    expect(second.id).toBe(first.id); // updated in place, not a new row
    expect(second.status).toBe('present');
    expect(second.ltiUserId).toBe('user-1');

    const rows = await db.select().from(attendanceRecords).where(and(eq(attendanceRecords.attendanceSessionId, sessionId), eq(attendanceRecords.clientScanId, 'retry-1')));
    expect(rows).toHaveLength(1);
    expect(attempt).toBe(2); // resolver WAS called again on the retry
  });
});

describe('submitScan -- idempotency', () => {
  it('returns the same settled record, without calling the resolver again, for a duplicate clientScanId submitted sequentially', async () => {
    const { institutionId, sessionId } = await seedOpenSessionWithMember('1000000');
    const resolveCard = vi.fn().mockResolvedValue(successResolution({ universityId: '1000000' }));
    const resolver: IdentityResolver = { resolveCard };

    const first = await submitScan(db, sessionId, { clientScanId: 'dup-1', cardCode: 'CARD001', scannedAt: new Date().toISOString() }, { resolver, institution: { id: institutionId, cardFingerprintEnabled: false } });
    const second = await submitScan(db, sessionId, { clientScanId: 'dup-1', cardCode: 'CARD001', scannedAt: new Date().toISOString() }, { resolver, institution: { id: institutionId, cardFingerprintEnabled: false } });

    expect(second.id).toBe(first.id);
    expect(resolveCard).toHaveBeenCalledTimes(1); // 'present' is settled -> second call short-circuits before the resolver
  });

  it('when two concurrent requests race on the same clientScanId (lost-response-then-retried), exactly one attendance_records row exists and both callers see it', async () => {
    const { institutionId, sessionId } = await seedOpenSessionWithMember('1000000');
    const resolver: IdentityResolver = { resolveCard: async () => successResolution({ universityId: '1000000' }) };
    const input = { clientScanId: 'race-1', cardCode: 'CARD001', scannedAt: new Date().toISOString() };
    const deps = { resolver, institution: { id: institutionId, cardFingerprintEnabled: false } };

    const [a, b] = await Promise.all([submitScan(db, sessionId, input, deps), submitScan(db, sessionId, input, deps)]);

    expect(a.id).toBe(b.id);
    const allRows = await db.select().from(attendanceRecords).where(and(eq(attendanceRecords.attendanceSessionId, sessionId), eq(attendanceRecords.clientScanId, 'race-1')));
    expect(allRows).toHaveLength(1);
  });
});
