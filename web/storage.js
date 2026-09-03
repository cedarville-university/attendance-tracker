// storage.js
//
// Optional local persistence, entirely via localStorage. The app functions
// purely in-memory by default; nothing here runs unless the user has
// turned on "Remember this session on this computer".
//
// Everything is stored under one namespaced JSON blob (SESSION_STORAGE_KEY,
// from config.js) rather than several scattered keys, so "Clear Local
// Data" is a single, atomic, predictable removal.
//
// WebHID device permission grants are NEVER stored here -- hid-reader.js
// always rediscovers previously-authorized devices via
// navigator.hid.getDevices() instead.

import { SESSION_STORAGE_KEY } from './config.js';
import { logEvent } from './diagnostics.js';

const SCHEMA_VERSION = 1;
const SAVE_DEBOUNCE_MS = 300;

let saveTimer = null;

/**
 * @returns {boolean} Whether localStorage is actually usable in this
 * browsing context (it can throw in private-browsing modes or when
 * disabled by policy, even though `window.localStorage` exists).
 */
export function isStorageAvailable() {
  try {
    const testKey = '__attendance_tracker_storage_test__';
    localStorage.setItem(testKey, '1');
    localStorage.removeItem(testKey);
    return true;
  } catch {
    return false;
  }
}

/**
 * @returns {boolean} Whether a previously saved session exists, without
 * loading/parsing it. Used at startup to decide whether to offer a
 * "Restore previous session?" prompt.
 */
export function hasSavedSession() {
  try {
    return localStorage.getItem(SESSION_STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

/**
 * @typedef {Object} PersistedSessionState
 * @property {Array<object>} attendanceRecords
 * @property {{suppressed: number}} duplicateCounters
 * @property {{filename: string|null, headers: string[], rawRows: Array<object>, idColumnHeader: string|null, enabled: boolean}} roster
 * @property {{soundAlertsEnabled: boolean, rememberSession: boolean}} preferences
 */

/**
 * Immediately writes the given state to localStorage.
 * @param {PersistedSessionState} state
 * @returns {boolean} success
 */
export function saveSessionNow(state) {
  try {
    const payload = {
      schemaVersion: SCHEMA_VERSION,
      savedAt: new Date().toISOString(),
      attendanceRecords: state.attendanceRecords || [],
      duplicateCounters: state.duplicateCounters || { suppressed: 0 },
      roster: state.roster || { filename: null, headers: [], rawRows: [], idColumnHeader: null, enabled: false },
      preferences: state.preferences || { soundAlertsEnabled: true, rememberSession: false },
    };
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(payload));
    return true;
  } catch (err) {
    logEvent('error', { kind: 'local-storage-unavailable', message: `Failed to save session: ${err.message}` });
    return false;
  }
}

/**
 * Debounced version of saveSessionNow, so a burst of rapid scans doesn't
 * trigger a synchronous localStorage write per scan.
 * @param {PersistedSessionState} state
 */
export function saveSessionDebounced(state) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveSessionNow(state);
  }, SAVE_DEBOUNCE_MS);
}

/**
 * Loads and parses the saved session, if any.
 * @returns {PersistedSessionState & {schemaVersion: number, savedAt: string} | null}
 */
export function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (raw === null) return null;
    return JSON.parse(raw);
  } catch (err) {
    logEvent('error', { kind: 'local-storage-unavailable', message: `Failed to load saved session: ${err.message}` });
    return null;
  }
}

/**
 * Removes the saved session from localStorage. Backs the "Clear Local
 * Data" button. Does not touch any in-memory state -- that's the job of
 * the existing "Clear Roster" / "Clear all attendance" actions.
 * @returns {boolean} success
 */
export function clearLocalData() {
  try {
    localStorage.removeItem(SESSION_STORAGE_KEY);
    return true;
  } catch (err) {
    logEvent('error', { kind: 'local-storage-unavailable', message: `Failed to clear local data: ${err.message}` });
    return false;
  }
}
