// roster.js
//
// Hand-written CSV parsing and roster indexing for the optional class
// roster validation feature. No third-party CSV library is used.
//
// University IDs are always handled as trimmed strings, never coerced to
// numbers, so leading zeroes are preserved. No roster data parsed here is
// ever transmitted anywhere -- it stays in memory (and, optionally, in
// localStorage if the user opts in via storage.js).

import { logEvent } from './diagnostics.js';

/**
 * Parses CSV text into a header row and an array of row objects keyed by
 * header name. Handles:
 *   - commas inside double-quoted fields
 *   - escaped double quotes ("" inside a quoted field)
 *   - both CRLF and bare LF line endings
 *   - blank lines (skipped)
 *   - a leading UTF-8 BOM (stripped)
 *
 * Field values are returned exactly as written (not trimmed), so export
 * round-trips preserve the original data; trimming for ID-matching
 * purposes happens in buildRosterIndex()/normalizeId() instead.
 *
 * @param {string} text
 * @returns {{headers: string[], rows: Array<Record<string, string>>}}
 */
export function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1); // strip UTF-8 BOM
  }

  const rawRows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const len = text.length;

  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    rawRows.push(row);
    row = [];
  };

  while (i < len) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i += 1;
        }
      } else {
        field += char;
        i += 1;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      i += 1;
    } else if (char === ',') {
      pushField();
      i += 1;
    } else if (char === '\r') {
      pushRow();
      i += text[i + 1] === '\n' ? 2 : 1;
    } else if (char === '\n') {
      pushRow();
      i += 1;
    } else {
      field += char;
      i += 1;
    }
  }
  // Flush a trailing field/row that wasn't terminated by a newline.
  if (field.length > 0 || row.length > 0) {
    pushRow();
  }

  const nonBlankRows = rawRows.filter((r) => !(r.length === 1 && r[0] === ''));
  if (nonBlankRows.length === 0) {
    return { headers: [], rows: [] };
  }

  const headers = nonBlankRows[0];
  const rows = nonBlankRows.slice(1).map((r) => {
    const obj = {};
    headers.forEach((header, index) => {
      obj[header] = r[index] !== undefined ? r[index] : '';
    });
    return obj;
  });

  return { headers, rows };
}

/**
 * Parses roster CSV text and logs the outcome to diagnostics. Always
 * returns a well-formed result (never throws) so a malformed file
 * produces a visible, recoverable error rather than crashing the app.
 * @param {string} text
 * @param {string} filename
 * @returns {{headers: string[], rows: Array<Record<string, string>>, error: string|null}}
 */
export function loadRosterCsv(text, filename) {
  try {
    const { headers, rows } = parseCsv(text);
    if (headers.length === 0) {
      const message = 'The CSV file appears to be empty or has no header row.';
      logEvent('roster-error', { filename, message });
      return { headers: [], rows: [], error: message };
    }
    logEvent('roster-loaded', { filename, headerCount: headers.length, rowCount: rows.length });
    return { headers, rows, error: null };
  } catch (err) {
    const message = `Failed to parse roster CSV: ${err.message}`;
    logEvent('roster-error', { filename, message });
    return { headers: [], rows: [], error: message };
  }
}

/**
 * Normalizes a University ID for comparison: coerced to a trimmed string,
 * never a number (so leading zeroes are never lost).
 * @param {any} id
 * @returns {string}
 */
export function normalizeId(id) {
  return id == null ? '' : String(id).trim();
}

/**
 * Builds a Map from normalized University ID to the full original CSV row
 * object, so exported attendance rows can include arbitrary roster
 * columns (name, section, email, classification, ...) without the app
 * needing to know those column names in advance.
 * @param {Array<Record<string, string>>} rows
 * @param {string} idColumnHeader
 * @returns {Map<string, Record<string, string>>}
 */
export function buildRosterIndex(rows, idColumnHeader) {
  const index = new Map();
  for (const row of rows) {
    const id = normalizeId(row[idColumnHeader]);
    if (id === '') continue;
    index.set(id, row);
  }
  return index;
}

/**
 * @param {Map<string, Record<string, string>>} index
 * @param {string} universityId
 * @returns {boolean}
 */
export function isExpected(index, universityId) {
  return index.has(normalizeId(universityId));
}

/**
 * @param {Map<string, Record<string, string>>} index
 * @param {string} universityId
 * @returns {Record<string, string>|null}
 */
export function getRosterRow(index, universityId) {
  return index.get(normalizeId(universityId)) || null;
}
