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
//     error: null | { kind: 'timeout'|'network'|'http-status'|'bad-json'|'missing-university-id', message: string },
//   }
//
// To add another field returned by a real API (e.g. "section" or
// "classification"): add a `sectionField: 'section'` entry to
// LOOKUP_CONFIG in config.js, then add one line to
// mapRawResponseToNormalized() below.

import { LOOKUP_CONFIG } from './config.js';
import { logEvent } from './diagnostics.js';

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
 * Real fetch-based adapter. Reads everything it needs from LOOKUP_CONFIG.
 * @param {string} cardCode
 */
async function realLookup(cardCode) {
  const url = LOOKUP_CONFIG.url.replace('{CARD_CODE}', encodeURIComponent(cardCode));
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
      return errorResult('timeout', `Card lookup timed out after ${LOOKUP_CONFIG.timeoutMs}ms.`);
    }
    return errorResult('network', `Card lookup failed: ${err.message}`);
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    return errorResult('http-status', `Card lookup API returned HTTP ${response.status} ${response.statusText}`);
  }

  let json;
  try {
    json = await response.json();
  } catch (err) {
    return errorResult('bad-json', `Card lookup API returned a response that was not valid JSON: ${err.message}`);
  }

  const normalized = mapRawResponseToNormalized(json);
  if (!normalized.universityId) {
    return errorResult('missing-university-id', 'Card lookup API response did not include a University ID.', json);
  }

  return successResult(normalized, json);
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
