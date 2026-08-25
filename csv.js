// csv.js
//
// Client-side generation of the "Download Attendance CSV" export. Builds
// the CSV entirely in the browser via a Blob and an object URL -- no
// library, no server round-trip.
//
// The column set is the UNION of fields actually present across all scan
// records (base fields + every key ever seen in a record's lookupData +
// every key ever seen in a record's rosterData), so new normalized-lookup
// fields or new roster columns show up in the export automatically without
// this file needing to know their names in advance.

import { logEvent } from './diagnostics.js';

const BASE_COLUMNS = ['timestamp', 'rawCardCode', 'universityId', 'rosterStatus', 'status'];

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
  const lookupKeys = [];
  const rosterKeys = [];
  const seenLookup = new Set();
  const seenRoster = new Set();

  for (const record of records) {
    for (const key of Object.keys(record.lookupData || {})) {
      if (!seenLookup.has(key)) {
        seenLookup.add(key);
        lookupKeys.push(key);
      }
    }
    for (const key of Object.keys(record.rosterData || {})) {
      if (!seenRoster.has(key)) {
        seenRoster.add(key);
        rosterKeys.push(key);
      }
    }
  }

  const columns = [...BASE_COLUMNS, ...lookupKeys.map((k) => `lookup.${k}`), ...rosterKeys.map((k) => `roster.${k}`)];

  const lines = [columns.map(csvEscapeField).join(',')];
  for (const record of records) {
    const values = columns.map((column) => {
      if (BASE_COLUMNS.includes(column)) return record[column];
      if (column.startsWith('lookup.')) return (record.lookupData || {})[column.slice('lookup.'.length)];
      if (column.startsWith('roster.')) return (record.rosterData || {})[column.slice('roster.'.length)];
      return '';
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
 * Builds the CSV, triggers a browser download via a Blob + object URL, and
 * revokes the URL shortly after. Never throws -- returns a result object
 * so the caller can show a visible error message on failure.
 * @param {Array<object>} records
 * @returns {{ok: boolean, filename?: string, error?: string}}
 */
export function downloadAttendanceCsv(records) {
  try {
    const csvString = buildAttendanceCsv(records);
    const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const filename = buildExportFilename();

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
