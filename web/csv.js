// csv.js
//
// Client-side generation of the "Download Attendance CSV" export. Builds
// the CSV entirely in the browser via a Blob and an object URL -- no
// library, no server round-trip.
//
// This is the standalone / no-session export path only. When a persisted
// attendance session is active, app.js downloads the server-authoritative
// CSV from GET /api/attendance-sessions/{id}/export.csv instead.
//
// Phase 5 renamed the scan record's `universityId` -> `institutionalId` and
// removed the per-record `rosterStatus` / `lookupData` / `rosterData` blobs
// (roster matching is now server-side), so the column set is a fixed list.

import { logEvent } from './diagnostics.js';

// timestamp, rawCardCode, institutionalId, status come straight off the
// ScanRecord (scan-pipeline.js) / AbsentRow (absentees.js); `attendance` is
// derived ("Present" / "Absent").
const BASE_COLUMNS = ['timestamp', 'rawCardCode', 'institutionalId', 'status', 'attendance'];

/**
 * Quotes a CSV field only when necessary (RFC 4180 style): if it contains
 * a comma, double quote, or newline. Embedded double quotes are doubled.
 * @param {any} value
 * @returns {string}
 */
export function csvEscapeField(value) {
  const str = value === null || value === undefined ? '' : String(value);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Builds the full attendance CSV as a single string (CRLF line endings).
 * @param {Array<object>} records - scan records, as produced by scan-pipeline.js
 * @returns {string}
 */
export function buildAttendanceCsv(records) {
  const lines = [BASE_COLUMNS.map(csvEscapeField).join(',')];
  for (const record of records) {
    const values = BASE_COLUMNS.map((column) => {
      if (column === 'attendance') return record.isAbsent ? 'Absent' : 'Present';
      return record[column];
    });
    lines.push(values.map(csvEscapeField).join(','));
  }
  return lines.join('\r\n');
}

/**
 * Builds a filename like "attendance-2026-08-24.csv" using the local date
 * (not UTC), so the filename matches the professor's own clock even close
 * to midnight.
 * @returns {string}
 */
function buildExportFilename() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `attendance-${yyyy}-${mm}-${dd}.csv`;
}

/**
 * Triggers a browser download of an already-built CSV string via a Blob +
 * object URL, revoking the URL shortly after. Never throws.
 * @param {string} csvString
 * @param {string} [filename]
 * @returns {{ok: boolean, filename?: string, error?: string}}
 */
export function downloadCsvText(csvString, filename = buildExportFilename()) {
  try {
    const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);

    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    setTimeout(() => URL.revokeObjectURL(url), 1000);

    return { ok: true, filename };
  } catch (err) {
    logEvent('error', { kind: 'csv-export-failed', message: err.message });
    return { ok: false, error: err.message };
  }
}

/**
 * Builds the CSV from in-memory records, then downloads it. Standalone /
 * no-session path only. Never throws.
 * @param {Array<object>} records
 * @returns {{ok: boolean, filename?: string, error?: string}}
 */
export function downloadAttendanceCsv(records) {
  try {
    return downloadCsvText(buildAttendanceCsv(records));
  } catch (err) {
    logEvent('error', { kind: 'csv-export-failed', message: err.message });
    return { ok: false, error: err.message };
  }
}
