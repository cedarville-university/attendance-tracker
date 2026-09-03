import { describe, it, expect } from 'vitest';
import { eligibleUnrecordedMembers } from '../manual-present.js';

const member = (over) => ({
  ltiUserId: 'u',
  displayName: 'Someone',
  institutionalId: '0001',
  eligibleForAttendance: true,
  currentRecord: null,
  ...over,
});

describe('eligibleUnrecordedMembers', () => {
  it('drops members not eligible for attendance', () => {
    const rows = eligibleUnrecordedMembers([
      member({ ltiUserId: 'a', displayName: 'Alice', eligibleForAttendance: false }),
      member({ ltiUserId: 'b', displayName: 'Bob' }),
    ]);
    expect(rows.map((r) => r.ltiUserId)).toEqual(['b']);
  });

  it('drops members already marked present', () => {
    const rows = eligibleUnrecordedMembers([
      member({ ltiUserId: 'a', displayName: 'Alice', currentRecord: { status: 'present' } }),
      member({ ltiUserId: 'b', displayName: 'Bob', currentRecord: { status: 'absent' } }),
      member({ ltiUserId: 'c', displayName: 'Cara' }),
    ]);
    expect(rows.map((r) => r.ltiUserId)).toEqual(['b', 'c']);
  });

  it('keeps members with no record or a non-present record', () => {
    const rows = eligibleUnrecordedMembers([
      member({ ltiUserId: 'a', displayName: 'Alice', currentRecord: { status: 'excused' } }),
      member({ ltiUserId: 'b', displayName: 'Bob', currentRecord: null }),
    ]);
    expect(rows.map((r) => r.ltiUserId)).toEqual(['a', 'b']);
  });

  it('sorts by display name, case-insensitively', () => {
    const rows = eligibleUnrecordedMembers([
      member({ ltiUserId: 'c', displayName: 'charlie' }),
      member({ ltiUserId: 'a', displayName: 'Alice' }),
      member({ ltiUserId: 'b', displayName: 'Bob' }),
    ]);
    expect(rows.map((r) => r.displayName)).toEqual(['Alice', 'Bob', 'charlie']);
  });

  it('tolerates an empty or missing list', () => {
    expect(eligibleUnrecordedMembers([])).toEqual([]);
    expect(eligibleUnrecordedMembers(undefined)).toEqual([]);
  });
});
