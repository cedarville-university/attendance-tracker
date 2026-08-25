// omnikey-parser.js
//
// Parses HID input reports emitted by an HID Global OMNIKEY 5427CK reader
// configured for "Custom Report" output (Keyboard Wedge Enable: ON,
// Output Type: Custom Report). This is NOT the keyboard-emulation output
// format -- Custom Report packets arrive as raw HID input reports, not
// keystroke/keydown events.
//
// Documented packet shape (per OMNIKEY 5x27CK Custom Report spec), up to
// 40 bytes total:
//   byte 0            : number of data bytes ("declared length")
//   byte 1            : report/protocol version
//   bytes 2..N        : card/output data (the payload)
//   remaining bytes   : zero padding
//
// The exact behavior of a given reader/firmware/browser combination has
// NOT been verified against physical hardware yet, so this parser is
// deliberately defensive and keeps every offset as a named constant below
// so it can be adjusted in one place after testing against a real 5427CK.
//
// This module is pure and side-effect free: no DOM, no navigator.hid, no
// imports. That makes it trivially testable/adjustable in isolation
// (e.g. from a browser console) without any hardware attached.

// ---- Tunable protocol constants -------------------------------------------
// Adjust these if a real reader's report layout differs from the
// documented Custom Report format described above.

export const LENGTH_BYTE_OFFSET = 0; // byte index holding the declared payload length
export const VERSION_BYTE_OFFSET = 1; // byte index holding the protocol/report version
export const PAYLOAD_START_OFFSET = 2; // byte index where card/output data begins
export const MIN_REPORT_BYTES = 2; // minimum bytes needed to read length + version
export const MAX_REASONABLE_PAYLOAD = 40; // reports are documented as "up to 40 bytes" total

/**
 * @typedef {Object} OmnikeyParseResult
 * @property {number|undefined} reportId - HID report ID from the inputreport event, if provided.
 * @property {string} timestamp - ISO 8601 timestamp of when this report was parsed.
 * @property {string} rawHex - Full original buffer as a hex string (space separated), for diagnostics.
 * @property {number|null} declaredLength - Raw value of byte 0, or null if the buffer was too short to read it.
 * @property {number|null} version - Raw value of byte 1, or null if the buffer was too short to read it.
 * @property {boolean} lengthWasImplausible - True if the declared length exceeded the bytes actually available,
 *   meaning a trailing-zero-trim fallback was used instead of trusting the declared length.
 * @property {Uint8Array} rawPayloadBytes - The extracted payload bytes actually used (bounds-checked slice).
 * @property {string} asciiString - Untrimmed ASCII decode of rawPayloadBytes.
 * @property {string} trimmedCardCode - asciiString with leading/trailing whitespace/control chars removed.
 *   This is the candidate card code used by the rest of the application.
 * @property {boolean} hasPayload - True only if trimmedCardCode is non-empty. False for structurally valid
 *   but data-less reports (e.g. Card In / Card Out / prestroke / poststroke reports).
 * @property {boolean} valid - False only when the report failed to parse structurally (e.g. too short to
 *   even contain a length/version header). A data-less-but-structurally-fine report is still valid: true.
 * @property {string} note - Always-populated human-readable explanation of what happened.
 */

/**
 * Converts a DataView or Uint8Array to a space-separated hex string, e.g. "04 01 41 42 43 44".
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function bytesToHex(bytes) {
  const parts = [];
  for (let i = 0; i < bytes.length; i++) {
    parts.push(bytes[i].toString(16).padStart(2, '0'));
  }
  return parts.join(' ');
}

/**
 * Decodes a Uint8Array as ASCII (one character per byte, 7-bit-safe).
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function decodeAscii(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += String.fromCharCode(bytes[i]);
  }
  return out;
}

/**
 * Trims trailing zero bytes from a Uint8Array, returning a new (possibly shorter) view.
 * Used only as a fallback when the declared length can't be trusted -- in that branch we
 * genuinely don't know where the real payload ends, so trailing-zero-trim is the safest guess.
 * This must NOT be applied when the declared length is trusted, since a zero byte legitimately
 * embedded inside a trusted declared-length payload must be preserved, not discarded.
 * @param {Uint8Array} bytes
 * @returns {Uint8Array}
 */
function trimTrailingZeros(bytes) {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) {
    end--;
  }
  return bytes.subarray(0, end);
}

/**
 * Parses a single HID input report against the OMNIKEY Custom Report format.
 *
 * @param {number|undefined} reportId - The HID report ID from the inputreport event.
 * @param {DataView} dataView - event.data from the WebHID `inputreport` event.
 * @returns {OmnikeyParseResult}
 */
export function parseOmnikeyReport(reportId, dataView) {
  const timestamp = new Date().toISOString();
  const fullBytes = new Uint8Array(dataView.buffer, dataView.byteOffset, dataView.byteLength);
  const rawHex = bytesToHex(fullBytes);

  if (dataView.byteLength < MIN_REPORT_BYTES) {
    return {
      reportId,
      timestamp,
      rawHex,
      declaredLength: null,
      version: null,
      lengthWasImplausible: false,
      rawPayloadBytes: new Uint8Array(0),
      asciiString: '',
      trimmedCardCode: '',
      hasPayload: false,
      valid: false,
      note: `Report too short (${dataView.byteLength} byte(s)) to contain a length/version header (need at least ${MIN_REPORT_BYTES}).`,
    };
  }

  const declaredLength = dataView.getUint8(LENGTH_BYTE_OFFSET);
  const version = dataView.getUint8(VERSION_BYTE_OFFSET);
  const availablePayloadBytes = Math.max(0, dataView.byteLength - PAYLOAD_START_OFFSET);

  let lengthWasImplausible = false;
  let effectiveLength;
  if (declaredLength > availablePayloadBytes || declaredLength > MAX_REASONABLE_PAYLOAD) {
    lengthWasImplausible = true;
    effectiveLength = Math.min(availablePayloadBytes, MAX_REASONABLE_PAYLOAD);
  } else {
    effectiveLength = declaredLength;
  }

  let rawPayloadBytes = new Uint8Array(
    dataView.buffer,
    dataView.byteOffset + PAYLOAD_START_OFFSET,
    effectiveLength
  );

  // Only trim trailing zero padding when we couldn't trust the declared length. When the
  // declared length is trustworthy, rawPayloadBytes already ends exactly where the reader
  // said the data ends, so any zero byte inside that span is real data, not padding.
  if (lengthWasImplausible) {
    rawPayloadBytes = trimTrailingZeros(rawPayloadBytes);
  }

  const asciiString = decodeAscii(rawPayloadBytes);
  // eslint-disable-next-line no-control-regex
  const trimmedCardCode = asciiString.replace(/^[\s\x00-\x1f]+|[\s\x00-\x1f]+$/g, '');
  const hasPayload = trimmedCardCode.length > 0;

  let note;
  if (lengthWasImplausible) {
    note = `Declared length (${declaredLength}) exceeded available/reasonable payload bytes; used trailing-zero-trim fallback over ${availablePayloadBytes} available byte(s).`;
  } else if (!hasPayload) {
    note = 'Structurally valid report with an empty payload (likely a Card In / Card Out / prestroke / poststroke report, not card data).';
  } else {
    note = `Parsed ${rawPayloadBytes.length} declared payload byte(s) using protocol version ${version}.`;
  }

  return {
    reportId,
    timestamp,
    rawHex,
    declaredLength,
    version,
    lengthWasImplausible,
    rawPayloadBytes,
    asciiString,
    trimmedCardCode,
    hasPayload,
    valid: true,
    note,
  };
}
