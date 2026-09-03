import { describe, it, expect } from 'vitest';
import { resolveCurrentRecord } from '../../src/attendance/member-status.js';
import type { AttendanceRecordRow } from '../../src/database/schema.js';

function record(overrides: Partial<AttendanceRecordRow>): AttendanceRecordRow {
  return {
    id: 'rec-1',
    attendanceSessionId: 'session-1',
    ltiUserId: 'user-1',
    institutionalId: '1000000',
    clientScanId: null,
    status: 'present',
    scannedAt: new Date('2026-08-26T10:00:00Z'),
    source: 'card',
    cardFingerprint: null,
    lookupErrorKind: null,
    createdAt: new Date('2026-08-26T10:00:00Z'),
    updatedAt: new Date('2026-08-26T10:00:00Z'),
    ...overrides,
  } as AttendanceRecordRow;
}

describe('resolveCurrentRecord', () => {
  it('returns null for an empty record list', () => {
    expect(resolveCurrentRecord([])).toBeNull();
  });

  it('returns the only record when there is exactly one', () => {
    const r = record({ id: 'only' });
    expect(resolveCurrentRecord([r])).toBe(r);
  });

  it('returns the record with the latest createdAt when multiple exist, regardless of insertion order', () => {
    const older = record({ id: 'older', status: 'present', createdAt: new Date('2026-08-26T10:00:00Z') });
    const newer = record({ id: 'newer', status: 'excused', createdAt: new Date('2026-08-26T10:05:00Z') });
    expect(resolveCurrentRecord([older, newer])!.id).toBe('newer');
    expect(resolveCurrentRecord([newer, older])!.id).toBe('newer'); // order-independent
  });

  it('breaks a createdAt tie by id, deterministically, rather than by array order', () => {
    const tiedTime = new Date('2026-08-26T10:00:00Z');
    const a = record({ id: 'aaa', createdAt: tiedTime });
    const b = record({ id: 'bbb', createdAt: tiedTime });
    expect(resolveCurrentRecord([a, b])!.id).toBe(resolveCurrentRecord([b, a])!.id);
  });
});
