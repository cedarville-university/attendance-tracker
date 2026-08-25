// diagnostics.js
//
// A small in-memory ring buffer of diagnostic/error events, used to power
// the "Reader Diagnostics" panel and the "Copy Diagnostics" / "Clear
// Diagnostics" buttons. This module is a dependency-free leaf: every other
// module (hid-reader, lookup, roster, csv, storage, scan-pipeline) imports
// and calls into it, but it imports nothing itself, which avoids circular
// module dependencies.
//
// Event categories in use elsewhere in the app:
//   webhid-support       - WebHID availability / secure-origin check at startup
//   device-connected      - a reader was opened; detail carries VID/PID/collections
//   device-disconnected   - a reader was closed or lost
//   raw-report            - a raw HID report was received (only logged when debug mode is on)
//   parsed-report          - the result of running a report through the OMNIKEY parser
//   lookup-request        - a card lookup was initiated
//   lookup-result          - a card lookup resolved (success or error)
//   roster-loaded         - a roster CSV was parsed successfully
//   roster-error           - a roster CSV failed to parse or had no usable ID column
//   error                  - a catch-all for user-facing error conditions

import { DIAGNOSTICS_RING_BUFFER_SIZE } from './config.js';

/** @type {Array<{id: number, timestamp: string, category: string, detail: any}>} */
const events = [];
let nextId = 1;

/** @type {((event: {id: number, timestamp: string, category: string, detail: any}) => void)|null} */
let listener = null;

/**
 * Registers a callback fired synchronously every time logEvent() is
 * called, from any module. Used by app.js to keep the Diagnostics panel's
 * live error log in sync without every module needing to import ui.js.
 * Only one listener is supported (the app has a single diagnostics view).
 * @param {(event: {id: number, timestamp: string, category: string, detail: any}) => void} fn
 */
export function setListener(fn) {
  listener = fn;
}

/**
 * Records a diagnostic event. Oldest events are dropped once the ring
 * buffer exceeds DIAGNOSTICS_RING_BUFFER_SIZE.
 * @param {string} category
 * @param {any} [detail]
 */
export function logEvent(category, detail) {
  const event = {
    id: nextId++,
    timestamp: new Date().toISOString(),
    category,
    detail: detail ?? null,
  };
  events.push(event);
  while (events.length > DIAGNOSTICS_RING_BUFFER_SIZE) {
    events.shift();
  }
  if (listener) listener(event);
}

/**
 * Returns a shallow copy of the current events, oldest first.
 * @returns {Array<{id: number, timestamp: string, category: string, detail: any}>}
 */
export function getEvents() {
  return events.slice();
}

/** Empties the ring buffer (backs the "Clear Diagnostics" button). */
export function clear() {
  events.length = 0;
}

/**
 * Flattens a detail value into a short single-line summary for the plain-text
 * diagnostics dump. Objects are JSON-stringified; everything else is
 * stringified directly.
 * @param {any} detail
 * @returns {string}
 */
function summarizeDetail(detail) {
  if (detail === null || detail === undefined) return '';
  if (typeof detail === 'string') return detail;
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}

/**
 * Formats all current events as plain text suitable for pasting into a bug
 * report, e.g. via the "Copy Diagnostics" button.
 * @returns {string}
 */
export function toCopyText() {
  const lines = [
    `Attendance Tracker diagnostics dump (${new Date().toISOString()})`,
    `${events.length} event(s) in buffer (max ${DIAGNOSTICS_RING_BUFFER_SIZE})`,
    '',
  ];
  for (const event of events) {
    lines.push(`[${event.timestamp}] ${event.category.toUpperCase()}: ${summarizeDetail(event.detail)}`);
  }
  return lines.join('\n');
}
