// credentials.js
//
// Runtime-only storage for the card-lookup API credentials (key name + key),
// entered by the professor into the "Card Lookup API Credentials" panel.
// These never live in config.js -- config.js ships to every browser that
// loads the page, so a real secret can't be hardcoded there.
//
// Persisted to its own localStorage key, separate from SESSION_STORAGE_KEY
// and independent of the "Remember this session" toggle: this is
// operational configuration, not student attendance data, so it shouldn't
// need to be re-entered every class period just because a professor prefers
// not to keep attendance data on disk.

import { logEvent } from './diagnostics.js';

const CREDENTIALS_STORAGE_KEY = 'attendance-tracker:v1:api-credentials';

let credentials = { keyName: '', key: '' };

/** @returns {{keyName: string, key: string}} */
export function getCredentials() {
  return { ...credentials };
}

/** @param {{keyName: string, key: string}} next */
export function setCredentials({ keyName, key }) {
  credentials = { keyName: (keyName || '').trim(), key: (key || '').trim() };
  try {
    localStorage.setItem(CREDENTIALS_STORAGE_KEY, JSON.stringify(credentials));
  } catch (err) {
    logEvent('error', { kind: 'local-storage-unavailable', message: `Failed to save API credentials: ${err.message}` });
  }
}

export function clearCredentials() {
  credentials = { keyName: '', key: '' };
  try {
    localStorage.removeItem(CREDENTIALS_STORAGE_KEY);
  } catch (err) {
    logEvent('error', { kind: 'local-storage-unavailable', message: `Failed to clear API credentials: ${err.message}` });
  }
}

/** Loads previously saved credentials (if any) into memory. Call once at startup. */
export function loadPersistedCredentials() {
  try {
    const raw = localStorage.getItem(CREDENTIALS_STORAGE_KEY);
    if (raw === null) return;
    const parsed = JSON.parse(raw);
    credentials = { keyName: parsed.keyName || '', key: parsed.key || '' };
  } catch (err) {
    logEvent('error', { kind: 'local-storage-unavailable', message: `Failed to load saved API credentials: ${err.message}` });
  }
}
