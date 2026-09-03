import { describe, it, expect } from 'vitest';
import { computeAbsentRows, computeAbsentRowsFromMembers } from '../absentees.js';

describe('computeAbsentRows (CSV roster)', () => {
  it('returns one row per roster ID with no matching scan', () => {
    const rosterState = { index: new Map([['0041', {}], ['0042', {}], ['0043', {}]]) };
    const rows = computeAbsentRows({ rosterState, scannedIds: new Set(['0042']) });
    expect(rows.map((r) => r.institutionalId)).toEqual(['0041', '0043']);
    expect(rows[0]).toMatchObject({ isAbsent: true, timestamp: '', rawCardCode: '', status: '' });
  });
});

describe('computeAbsentRowsFromMembers (Canvas roster)', () => {
  const memberIndex = new Map([
    ['0041', { institutionalId: '0041', displayName: 'Ann Absent' }],
    ['0042', { institutionalId: '0042', displayName: 'Pat Present' }],
  ]);

  it('returns absent rows carrying the member display name', () => {
    const rows = computeAbsentRowsFromMembers({ memberIndex, scannedIds: new Set(['0042']) });
    expect(rows).toEqual([
      { id: 'absent-0041', timestamp: '', rawCardCode: '', institutionalId: '0041', displayName: 'Ann Absent', status: '', isAbsent: true },
    ]);
  });

  it('returns [] when everyone on the roster scanned', () => {
    const rows = computeAbsentRowsFromMembers({ memberIndex, scannedIds: new Set(['0041', '0042']) });
    expect(rows).toEqual([]);
  });
});
