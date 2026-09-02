// time-format.js
//
// Timestamp formatting for the scan/attendance views. DOM-free (like
// absentees.js and manual-present.js) so it can be unit-tested under the
// node-env vitest setup; ui.js imports it for the Latest Scan panel and the
// attendance table's Time column.

/** The table/panel convention for "this field has no value". */
const EMPTY = '—';

/**
 * Local date+time for an attendance record's scan timestamp.
 *
 * Not every record has one: manual corrections and system_absence rows are
 * written with `scannedAt: null` (spec §26), which serverRecordToRow maps to
 * ''. `new Date('')` is an Invalid Date and its toLocaleString() *returns* the
 * string "Invalid Date" rather than throwing, so the missing case has to be
 * checked explicitly -- a try/catch never sees it.
 *
 * @param {string|null|undefined} isoTimestamp
 * @returns {string} the formatted time, or '—' when there is no usable one
 */
export function formatLocalTime(isoTimestamp) {
  if (!isoTimestamp) return EMPTY;
  const d = new Date(isoTimestamp);
  if (Number.isNaN(d.getTime())) return EMPTY;
  return d.toLocaleString();
}
