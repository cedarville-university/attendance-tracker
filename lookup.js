// lookup.js
//
// The single, isolated adapter between a scanned card code and student
// identity information. Nothing else in the app should know how the
// external API is shaped, authenticated, or reached -- that all lives
// here and in the LOOKUP_CONFIG object in config.js.
//
// lookupCard() NEVER throws and NEVER rejects: every call resolves to the
// same normalized shape below, with `ok`/`error` describing what happened.
// This lets callers (scan-pipeline.js) always produce an attendance
// record -- a failed lookup still gets recorded with the raw card code,
// timestamp, and an error status, rather than silently dropping the scan.
//
// Normalized result shape:
//   {
//     ok: boolean,
//     universityId: string|null,
//     firstName: string|null,
//     lastName: string|null,
//     email: string|null,
//     raw: object|null,           // the original parsed JSON, for diagnostics only
//     error: null | { kind: 'timeout'|'network'|'http-status'|'bad-json'|'missing-university-id'|'missing-credentials', message: string },
//   }
//
// To add another field returned by a real API (e.g. "section" or
// "classification"): add a `sectionField: 'section'` entry to
// LOOKUP_CONFIG in config.js, then add one line to
// mapRawResponseToNormalized() below.

import { LOOKUP_CONFIG } from './config.js';
import { logEvent } from './diagnostics.js';
import { getCredentials } from './credentials.js';

/**
 * Reads a possibly dot-pathed field (e.g. "student.universityId") out of a
 * plain object.
 * @param {any} obj
 * @param {string} path
 * @returns {any}
 */
function getByPath(obj, path) {
  if (obj == null || !path) return undefined;
  return path.split('.').reduce((value, key) => (value == null ? undefined : value[key]), obj);
}

/**
 * Maps a raw parsed API response into the app's normalized flat shape.
 * This is the one place a developer needs to touch when the real API's
 * response fields differ from the LOOKUP_CONFIG defaults.
 * @param {any} rawJson
 * @returns {{universityId: string|null, firstName: string|null, lastName: string|null, email: string|null}}
 */
function mapRawResponseToNormalized(rawJson) {
  const rawUniversityId = getByPath(rawJson, LOOKUP_CONFIG.universityIdField);
  return {
    universityId: rawUniversityId == null ? null : String(rawUniversityId).trim(),
    firstName: getByPath(rawJson, LOOKUP_CONFIG.firstNameField) ?? null,
    lastName: getByPath(rawJson, LOOKUP_CONFIG.lastNameField) ?? null,
    email: getByPath(rawJson, LOOKUP_CONFIG.emailField) ?? null,
  };
}

function errorResult(kind, message, raw = null) {
  return { ok: false, universityId: null, firstName: null, lastName: null, email: null, raw, error: { kind, message } };
}

function successResult(normalized, raw) {
  return { ok: true, ...normalized, raw, error: null };
}

/**
 * Shared fetch mechanics for both the card-code and university-ID lookup
 * adapters: applies the request timeout, performs the fetch, and validates
 * the HTTP/JSON envelope. Does not know anything about student-identity
 * fields -- that's finalizeLookup()'s job.
 * @param {string} url
 * @returns {Promise<{ok: true, json: any} | {ok: false, errorKind: string, message: string}>}
 */
async function performApiRequest(url) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), LOOKUP_CONFIG.timeoutMs);

  let response;
  try {
    response = await fetch(url, {
      method: LOOKUP_CONFIG.method,
      headers: LOOKUP_CONFIG.headers(),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      return { ok: false, errorKind: 'timeout', message: `Lookup timed out after ${LOOKUP_CONFIG.timeoutMs}ms.` };
    }
    return { ok: false, errorKind: 'network', message: `Lookup failed: ${err.message}` };
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    return { ok: false, errorKind: 'http-status', message: `Lookup API returned HTTP ${response.status} ${response.statusText}` };
  }

  try {
    const json = await response.json();
    return { ok: true, json };
  } catch (err) {
    return { ok: false, errorKind: 'bad-json', message: `Lookup API returned a response that was not valid JSON: ${err.message}` };
  }
}

/**
 * Maps a raw parsed API response into the normalized result shape, failing
 * if no University ID could be extracted from it.
 * @param {any} json
 * @returns {ReturnType<typeof successResult> | ReturnType<typeof errorResult>}
 */
function finalizeLookup(json) {
  const normalized = mapRawResponseToNormalized(json);
  if (!normalized.universityId) {
    return errorResult('missing-university-id', 'Lookup API response did not include a University ID.', json);
  }
  return successResult(normalized, json);
}

/**
 * Real fetch-based adapter, keyed by card code. Reads everything it needs
 * from LOOKUP_CONFIG.
 * @param {string} cardCode
 */
async function realLookup(cardCode) {
  const { keyName, key } = getCredentials();
  if (!keyName || !key) {
    return errorResult('missing-credentials', 'Card lookup API key/keyname not set. Enter them in the Card Lookup API Credentials panel.');
  }

  const url = LOOKUP_CONFIG.url
    .replace('{CARD_CODE}', encodeURIComponent(cardCode))
    .replace('{KEY_NAME}', encodeURIComponent(keyName))
    .replace('{KEY}', encodeURIComponent(key));

  const requestResult = await performApiRequest(url);
  if (!requestResult.ok) {
    return errorResult(requestResult.errorKind, requestResult.message);
  }
  return finalizeLookup(requestResult.json);
}

/**
 * Real fetch-based adapter, keyed directly by University ID -- used to
 * enrich "Absent" roster rows, which have no scanned card code.
 * @param {string} universityId
 */
async function realPersonLookup(universityId) {
  const { keyName, key } = getCredentials();
  if (!keyName || !key) {
    return errorResult('missing-credentials', 'Card lookup API key/keyname not set. Enter them in the Card Lookup API Credentials panel.');
  }

  const url = LOOKUP_CONFIG.personByIdUrl
    .replace('{UNIVERSITY_ID}', encodeURIComponent(universityId))
    .replace('{KEY_NAME}', encodeURIComponent(keyName))
    .replace('{KEY}', encodeURIComponent(key));

  const requestResult = await performApiRequest(url);
  if (!requestResult.ok) {
    return errorResult(requestResult.errorKind, requestResult.message);
  }
  return finalizeLookup(requestResult.json);
}

// ---- MOCK ADAPTER -- for demo/dev use only, no network access ------------
//
// Produces a deterministic pseudo-student identity from the card code, so
// scanning the same card twice always resolves to the same "student" and
// roster matching can be exercised without a real backend. Replace by
// setting LOOKUP_CONFIG.useMock = false and configuring LOOKUP_CONFIG.url
// (and the *Field entries) to match a real institutional API.
//
// Two special-case card codes let you exercise the error UI paths without
// hardware: a card code containing "NOID" simulates a successful call that
// is missing a University ID; a card code containing "ERR" simulates a
// network failure.

const MOCK_FIRST_NAMES = ['Jane', 'Alex', 'Sam', 'Taylor', 'Jordan', 'Morgan', 'Casey', 'Riley'];
const MOCK_LAST_NAMES = ['Smith', 'Johnson', 'Lee', 'Garcia', 'Brown', 'Davis', 'Miller', 'Wilson'];

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mockLookup(cardCode) {
  await delay(150 + Math.floor(Math.random() * 750));

  const upperCode = cardCode.toUpperCase();
  if (upperCode.includes('ERR')) {
    return errorResult('network', 'Simulated network failure (mock adapter: card code contains "ERR").');
  }
  if (upperCode.includes('NOID')) {
    return errorResult('missing-university-id', 'Simulated missing University ID (mock adapter: card code contains "NOID").', {
      note: 'mock response intentionally omitted universityId',
    });
  }

  const hash = hashString(cardCode);
  const firstName = MOCK_FIRST_NAMES[hash % MOCK_FIRST_NAMES.length];
  const lastName = MOCK_LAST_NAMES[Math.floor(hash / MOCK_FIRST_NAMES.length) % MOCK_LAST_NAMES.length];
  const universityId = String(1000000 + (hash % 9000000));
  const email = `${firstName}.${lastName}${universityId.slice(-3)}@example.edu`.toLowerCase();

  const raw = { universityId, firstName, lastName, email, mock: true };
  return successResult({ universityId, firstName, lastName, email }, raw);
}

/**
 * Mock adapter for the university-ID lookup path (used to enrich "Absent"
 * roster rows). Same deterministic-hash approach as mockLookup(), but keyed
 * on (and echoing back) the University ID directly rather than a card code.
 * The same "ERR"/"NOID" substring convention applies, checked against the
 * University ID, so a roster row's ID can be crafted to exercise the failed-
 * absent-lookup path without a real API.
 */
async function mockPersonLookup(universityId) {
  await delay(150 + Math.floor(Math.random() * 750));

  const upperId = universityId.toUpperCase();
  if (upperId.includes('ERR')) {
    return errorResult('network', 'Simulated network failure (mock adapter: University ID contains "ERR").');
  }
  if (upperId.includes('NOID')) {
    return errorResult('missing-university-id', 'Simulated missing University ID (mock adapter: University ID contains "NOID").', {
      note: 'mock response intentionally omitted universityId',
    });
  }

  const hash = hashString(universityId);
  const firstName = MOCK_FIRST_NAMES[hash % MOCK_FIRST_NAMES.length];
  const lastName = MOCK_LAST_NAMES[Math.floor(hash / MOCK_FIRST_NAMES.length) % MOCK_LAST_NAMES.length];
  const email = `${firstName}.${lastName}${universityId.slice(-3)}@example.edu`.toLowerCase();

  const raw = { universityId, firstName, lastName, email, mock: true };
  return successResult({ universityId, firstName, lastName, email }, raw);
}

/**
 * Resolves a scanned card code to normalized student identity information.
 * Always resolves (never rejects) to the normalized shape documented above.
 * @param {string} cardCode
 * @returns {Promise<{ok: boolean, universityId: string|null, firstName: string|null, lastName: string|null, email: string|null, raw: any, error: null|{kind: string, message: string}}>}
 */
export async function lookupCard(cardCode) {
  logEvent('lookup-request', { cardCode, useMock: LOOKUP_CONFIG.useMock });

  const result = LOOKUP_CONFIG.useMock ? await mockLookup(cardCode) : await realLookup(cardCode);

  // Diagnostics intentionally omit name/email to limit incidental exposure
  // of student PII in copyable diagnostics text; the University ID and
  // error state are kept since they're the most useful fields for
  // debugging a lookup failure.
  logEvent('lookup-result', {
    cardCode,
    ok: result.ok,
    universityId: result.universityId,
    error: result.error,
  });

  return result;
}

/**
 * Resolves a University ID directly to normalized student identity
 * information -- used to enrich "Absent" roster rows during CSV export,
 * since those students never scanned a card and so have no card code to
 * look up by. Always resolves (never rejects) to the same normalized shape
 * as lookupCard().
 * @param {string} universityId
 * @returns {Promise<{ok: boolean, universityId: string|null, firstName: string|null, lastName: string|null, email: string|null, raw: any, error: null|{kind: string, message: string}}>}
 */
export async function lookupPerson(universityId) {
  logEvent('lookup-request', { universityId, useMock: LOOKUP_CONFIG.useMock, kind: 'person-by-id' });

  const result = LOOKUP_CONFIG.useMock ? await mockPersonLookup(universityId) : await realPersonLookup(universityId);

  logEvent('lookup-result', {
    universityId,
    ok: result.ok,
    error: result.error,
    kind: 'person-by-id',
  });

  return result;
}
