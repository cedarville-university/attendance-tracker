// config.js
//
// Central configuration for the attendance tracker's browser-side tunables.
// Card-lookup API configuration now lives server-side (see
// server/src/identity/) since Phase 2 moved identity resolution -- and any
// credentials it needs -- out of the browser entirely.

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
