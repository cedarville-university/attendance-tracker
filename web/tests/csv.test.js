import { describe, it, expect } from 'vitest';
import { buildAttendanceCsv, csvEscapeField } from '../csv.js';
import { computeAbsentRows } from '../absentees.js';

/** A present ScanRecord as produced by scan-pipeline.js (Phase 5 shape). */
function presentRecord(overrides = {}) {
  return {
    id: 'scan-1',
    timestamp: '2026-08-28T14:00:00.000Z',
    rawCardCode: 'CARD001',
    institutionalId: '1000000',
    clientScanId: 'c1',
    status: 'present',
    ...overrides,
  };
}

describe('buildAttendanceCsv', () => {
  it('emits exactly the base columns as the header row', () => {
    const csv = buildAttendanceCsv([]);
    expect(csv).toBe('timestamp,rawCardCode,institutionalId,status,attendance');
  });

  it('returns header-only for an empty record set', () => {
    expect(buildAttendanceCsv([]).split('\r\n')).toHaveLength(1);
  });

  it('round-trips a present record\'s institutionalId in the institutionalId column', () => {
    const csv = buildAttendanceCsv([presentRecord({ institutionalId: '2345678' })]);
    const [header, row] = csv.split('\r\n');
    const idIndex = header.split(',').indexOf('institutionalId');
    expect(row.split(',')[idIndex]).toBe('2345678');
  });

  it('marks the derived attendance column Present for a scan and Absent for an absent row', () => {
    const csv = buildAttendanceCsv([presentRecord(), { id: 'absent-9', timestamp: '', rawCardCode: '', institutionalId: '9', status: '', isAbsent: true }]);
    const lines = csv.split('\r\n');
    expect(lines[1].endsWith(',Present')).toBe(true);
    expect(lines[2].endsWith(',Absent')).toBe(true);
  });

  it('keeps RFC-4180 escaping (comma / quote / newline)', () => {
    expect(csvEscapeField('a,b')).toBe('"a,b"');
    expect(csvEscapeField('he said "hi"')).toBe('"he said ""hi"""');
    expect(csvEscapeField('line1\nline2')).toBe('"line1\nline2"');
    const csv = buildAttendanceCsv([presentRecord({ rawCardCode: 'CARD,001' })]);
    expect(csv).toContain('"CARD,001"');
  });

  it('a present record and a roster-derived absent row land their institutionalId in the same column', () => {
    const rosterState = { index: new Map([['1000000', { id: '1000000' }], ['2000000', { id: '2000000' }]]) };
    const scannedIds = new Set(['1000000']);
    const absentRows = computeAbsentRows({ rosterState, scannedIds });
    expect(absentRows).toHaveLength(1);
    expect(absentRows[0].institutionalId).toBe('2000000');

    const csv = buildAttendanceCsv([presentRecord({ institutionalId: '1000000' }), ...absentRows]);
    const lines = csv.split('\r\n');
    const idIndex = lines[0].split(',').indexOf('institutionalId');
    expect(lines[1].split(',')[idIndex]).toBe('1000000');
    expect(lines[2].split(',')[idIndex]).toBe('2000000');
  });
});
