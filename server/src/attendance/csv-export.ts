//
// Server-side port of web/csv.js's csvEscapeField, operating on
// AttendanceExportRow (already-resolved-to-current-status DB rows) instead
// of in-memory ScanRecord objects. The escaping rule is copied verbatim so
// exports produced before/after the Phase 5 migration are byte-identical
// for any field whose content doesn't change.

const COLUMNS = ['institutionalId', 'displayName', 'status', 'source', 'scannedAt'] as const;

export interface AttendanceExportRow {
  ltiUserId: string;
  institutionalId: string | null;
  displayName: string | null;
  status: string;
  scannedAt: string | null;
  source: string;
}

/** Verbatim port of web/csv.js's csvEscapeField. */
function csvEscapeField(value: unknown): string {
  const str = value === null || value === undefined ? '' : String(value);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function buildAttendanceSessionCsv(rows: AttendanceExportRow[]): string {
  const lines = [COLUMNS.map(csvEscapeField).join(',')];
  for (const row of rows) {
    lines.push(COLUMNS.map((column) => csvEscapeField(row[column])).join(','));
  }
  return lines.join('\r\n');
}
