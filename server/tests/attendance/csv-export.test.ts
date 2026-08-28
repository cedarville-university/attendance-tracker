import { describe, it, expect } from 'vitest';
import { buildAttendanceSessionCsv } from '../../src/attendance/csv-export.js';

describe('buildAttendanceSessionCsv', () => {
  it('produces a header row plus one row per member, CRLF-joined', () => {
    const csv = buildAttendanceSessionCsv([
      { ltiUserId: 'u1', institutionalId: '1000000', displayName: 'Jane Smith', status: 'present', scannedAt: '2026-08-26T10:00:00.000Z', source: 'card' },
    ]);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('institutionalId,displayName,status,source,scannedAt');
    expect(lines[1]).toBe('1000000,Jane Smith,present,card,2026-08-26T10:00:00.000Z');
  });

  it('quotes a field containing a comma, double quote, or newline, and doubles embedded quotes (RFC 4180)', () => {
    const csv = buildAttendanceSessionCsv([{ ltiUserId: 'u1', institutionalId: '1000000', displayName: 'Smith, "Jane"', status: 'present', scannedAt: '2026-08-26T10:00:00.000Z', source: 'manual' }]);
    expect(csv).toContain('"Smith, ""Jane"""');
  });

  it('renders a null field as an empty string, matching web/csv.js\'s csvEscapeField (a manual row has scannedAt null)', () => {
    const csv = buildAttendanceSessionCsv([{ ltiUserId: 'u1', institutionalId: null, displayName: null, status: 'excused', scannedAt: null, source: 'manual' }]);
    const dataLine = csv.split('\r\n')[1];
    expect(dataLine).toBe(',,excused,manual,');
  });

  it('returns just the header row for an empty record set', () => {
    const csv = buildAttendanceSessionCsv([]);
    expect(csv).toBe('institutionalId,displayName,status,source,scannedAt');
  });
});
