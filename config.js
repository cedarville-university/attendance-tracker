// config.js
//
// Central configuration for the attendance tracker. This is the one place
// a developer should need to edit to point the app at a real institutional
// card-lookup API, or to retune protocol/UI constants.

// ---- HID reader ------------------------------------------------------------

// HID Global's registered USB vendor ID. Used to filter the browser's
// device chooser so only compatible readers (e.g. the OMNIKEY 5427CK) are
// offered when the user clicks "Connect Card Reader". We deliberately do
// NOT filter by a specific product ID, since this app should work with any
// HID Global reader that speaks the same Custom Report protocol.
export const HID_VENDOR_ID = 0x076b;

// ---- Duplicate scan suppression --------------------------------------------

// If the same card code is scanned again within this many milliseconds of
// its last accepted scan, treat it as an accidental duplicate (e.g. a
// student leaving their card resting on the reader, or the reader firing
// more than one report per tap) rather than a second intentional scan.
export const DUPLICATE_SUPPRESS_WINDOW_MS = 2000;

// ---- Diagnostics ------------------------------------------------------------

// Number of most-recent diagnostic/error events retained in memory.
export const DIAGNOSTICS_RING_BUFFER_SIZE = 50;

// Whether the raw-HID-report debug view is shown by default. Intended to be
// left on during initial hardware bring-up, then set to false for normal
// day-to-day faculty use (it remains manually toggleable either way).
export const DEBUG_MODE_DEFAULT = true;

// ---- Local persistence -------------------------------------------------------

// localStorage key holding the entire optional saved-session blob. Bump the
// embedded schemaVersion (see storage.js) rather than this key name if the
// stored shape ever changes incompatibly.
export const SESSION_STORAGE_KEY = 'attendance-tracker:v1:session';

// ---- Card lookup API --------------------------------------------------------
//
// This is the ONLY place API-specific behavior should live. Everything that
// talks to the external card-lookup API is isolated in lookup.js, which
// reads its behavior from LOOKUP_CONFIG below.
//
// IMPORTANT: The external API's server must send an
// `Access-Control-Allow-Origin` header permitting this web app's origin
// (e.g. `https://attendance.example.edu`), since this is a pure
// browser-side client with no backend proxy to route around CORS.
//
// Do NOT put secret API keys, passwords, or other credentials here -- this
// file ships to every browser that loads the page.

export const LOOKUP_CONFIG = {
  // Set to false once a real API endpoint is configured below.
  useMock: true,

  // Example real endpoint shape: GET https://example.edu/api/card/{CARD_CODE}
  // The literal string "{CARD_CODE}" in `url` is replaced with the
  // URI-encoded card code read from the reader.
  url: 'https://example.edu/api/card/{CARD_CODE}',
  method: 'GET',

  // Called per-request so headers can include anything computed at request
  // time (but still no secrets -- browser-side headers are visible to
  // anyone who opens devtools).
  headers: () => ({
    Accept: 'application/json',
  }),

  // How long to wait for the API before giving up and recording a
  // lookup-error scan.
  timeoutMs: 5000,

  // Field name (or dot-path, e.g. "student.universityId") to read the
  // university ID from the raw JSON response. Update this (and the fields
  // below) to match the real API's response shape.
  universityIdField: 'universityId',
  firstNameField: 'firstName',
  lastNameField: 'lastName',
  emailField: 'email',
};
