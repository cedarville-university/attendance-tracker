// app.js
//
// Orchestration only: wires DOM events to the pipeline/roster/hid modules,
// owns the small amount of top-level mutable state that doesn't belong to
// any single module (roster selection state, the AudioContext), and calls
// ui.js to render on every state change. No HID parsing, lookup, roster
// matching, CSV, or storage logic lives in this file -- it delegates to
// the dedicated modules for all of that.

import { DEBUG_MODE_DEFAULT, ABSENT_LOOKUP_CONCURRENCY } from './config.js';
import * as diagnostics from './diagnostics.js';
import { HidReader, isWebHidSupported, isSecureContext } from './hid-reader.js';
import { loadRosterCsv, buildRosterIndex, normalizeId } from './roster.js';
import { ScanPipeline } from './scan-pipeline.js';
import { downloadAttendanceCsv } from './csv.js';
import { computeAbsentRows } from './absentees.js';
import * as storage from './storage.js';
import * as credentials from './credentials.js';
import * as ui from './ui.js';

const { elements } = ui;

// ---- Roster state (owned here; roster.js only provides pure helpers) ------

const rosterState = {
  enabled: false,
  filename: null,
  headers: [],
  rawRows: [],
  idColumnHeader: null,
  index: new Map(),
};

// ---- Export state (session-lifetime only; never persisted) ----------------

// Successful person-by-ID lookups for "Absent" export rows, keyed by
// normalized university ID. Failed lookups are never cached, so the next
// export retries them (mirrors ScanPipeline's retry-failed-lookups
// philosophy).
const absentLookupCache = new Map();
let exportInFlight = false;
// Bumped whenever roster state changes; an in-flight absent-lookup batch
// checks this to detect it's been superseded and should discard its result
// rather than downloading a CSV built against a stale roster.
let exportGeneration = 0;

// ---- Scan pipeline ----------------------------------------------------------

function handleRemoveRecord(id) {
  scanPipeline.removeRecord(id);
  ui.removeAttendanceRow(id);
  schedulePersist();
}

const scanPipeline = new ScanPipeline({
  getRosterState: () => ({ enabled: rosterState.enabled, index: rosterState.index }),
  callbacks: {
    onRecordCreated: (record) => {
      ui.addAttendanceRow(record, handleRemoveRecord);
      ui.renderLatestScanPending(record);
      schedulePersist();
    },
    onRecordUpdated: (record) => {
      ui.updateAttendanceRow(record);
      schedulePersist();
    },
    onLatestScanUpdate: (record) => {
      ui.renderLatestScanResult(record);
      if (record.rosterStatus === 'unexpected' && elements.soundAlertsToggle.checked) {
        playUnexpectedTone();
      }
    },
    onStatsChanged: (stats) => {
      ui.renderStats(stats, rosterState.enabled);
      schedulePersist();
    },
  },
});

// ---- WebHID transport ---------------------------------------------------------

const HID_ERROR_MESSAGES = {
  'webhid-unavailable': 'This browser does not support WebHID. Use a recent desktop Chrome or Edge.',
  'insecure-origin': 'This page must be served over HTTPS or from localhost to use the card reader.',
  'permission-denied': 'Reader access was denied, or the device chooser was closed without selecting a reader.',
  'no-device-selected': 'No compatible reader was selected.',
  'open-failed': 'Failed to open the card reader. It may already be in use by another application.',
  'close-failed': 'Failed to cleanly close the card reader.',
};

function describeHidError(kind, err) {
  return HID_ERROR_MESSAGES[kind] || `Reader error: ${err.message}`;
}

/** Strips the raw byte view before logging a parsed report (not usefully JSON-serializable). */
function parsedReportLogDetail(parsed) {
  const { rawPayloadBytes, ...rest } = parsed;
  return rest;
}

let everSawCardData = false;

const hidReader = new HidReader({
  onReport: ({ parsed }) => {
    const debugOn = elements.debugModeToggle.checked;
    if (debugOn) {
      diagnostics.logEvent('raw-report', { reportId: parsed.reportId, rawHex: parsed.rawHex, timestamp: parsed.timestamp });
      diagnostics.logEvent('parsed-report', parsedReportLogDetail(parsed));
      ui.addRawReportEntry(parsed);
    }

    scanPipeline.handleParsedReport(parsed);

    // Auto-collapse the diagnostics/hardware-test panel the first time we
    // see a structurally valid report with real card data, so a professor
    // doing day-to-day scanning isn't staring at raw hex dumps -- but a
    // developer bringing up a fresh reader sees it by default until then.
    if (!everSawCardData && parsed.valid && parsed.hasPayload) {
      everSawCardData = true;
      elements.diagnosticsPanel.open = false;
    }
  },
  onConnectionChange: ({ connected, device, reason }) => {
    ui.setReaderStatus({ connected, device });
    ui.setDiagDeviceInfo(device);
    if (!connected && reason === 'disconnected') {
      ui.showAppMessage('warning', 'The card reader was disconnected.');
    }
  },
  onError: (err, kind) => {
    ui.showAppMessage('error', describeHidError(kind, err));
  },
});

// ---- Audio alert (Web Audio API; no audio file) --------------------------------

/** @type {AudioContext|null} */
let audioContext = null;

function ensureAudioContext() {
  if (!audioContext) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return null;
    audioContext = new AudioContextClass();
  }
  if (audioContext.state === 'suspended') {
    audioContext.resume().catch(() => {});
  }
  return audioContext;
}

function playUnexpectedTone() {
  const ctx = ensureAudioContext();
  if (!ctx) return;
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = 'square';
  oscillator.frequency.setValueAtTime(880, ctx.currentTime);
  oscillator.frequency.setValueAtTime(660, ctx.currentTime + 0.15);
  gain.gain.setValueAtTime(0.0001, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
  oscillator.connect(gain).connect(ctx.destination);
  oscillator.start();
  oscillator.stop(ctx.currentTime + 0.4);
}

// The AudioContext is created/resumed on the Connect button click (a user
// gesture). Reconnecting to a previously-authorized device on page load
// happens without a gesture, so this one-time fallback resumes audio on
// the very first click anywhere, in case the reader auto-reconnected.
document.addEventListener(
  'click',
  () => {
    ensureAudioContext();
  },
  { once: true }
);

// ---- Reader connect / disconnect buttons -----------------------------------

elements.connectBtn.addEventListener('click', async () => {
  ensureAudioContext();
  try {
    await hidReader.connect();
  } catch {
    // Already surfaced via the onError callback.
  }
});

elements.disconnectBtn.addEventListener('click', () => {
  hidReader.disconnect();
});

// ---- API credentials wiring -----------------------------------------------------

elements.saveCredentialsBtn.addEventListener('click', () => {
  credentials.setCredentials({ keyName: elements.apiKeyNameInput.value, key: elements.apiKeyInput.value });
  const saved = credentials.getCredentials();
  const hasCredentials = !!(saved.keyName && saved.key);
  ui.setCredentialsStatus(hasCredentials ? 'Saved.' : 'No credentials saved.');
  ui.setApiKeyWarning(!hasCredentials);
});

elements.clearCredentialsBtn.addEventListener('click', () => {
  credentials.clearCredentials();
  ui.setCredentialsFields({ keyName: '', key: '' });
  ui.setCredentialsStatus('No credentials saved.');
  ui.setApiKeyWarning(true);
});

// ---- Roster wiring ------------------------------------------------------------

// Called after any change to rosterState (load/column-select/clear/enable):
// refreshes whether the Present/Absent export mode selector is shown, and
// invalidates any absent-lookup batch already in flight so it discards its
// result instead of downloading a CSV built against a stale roster.
function refreshExportControls() {
  exportGeneration += 1;
  ui.setExportControlsAvailability({ rosterActive: rosterState.enabled && rosterState.index.size > 0 });
}

elements.loadRosterBtn.addEventListener('click', () => {
  elements.rosterFileInput.click();
});

elements.rosterFileInput.addEventListener('change', () => {
  const file = elements.rosterFileInput.files && elements.rosterFileInput.files[0];
  elements.rosterFileInput.value = ''; // allow re-selecting the same file later
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    const result = loadRosterCsv(String(reader.result), file.name);
    if (result.error) {
      ui.showAppMessage('error', result.error);
      return;
    }
    rosterState.filename = file.name;
    rosterState.headers = result.headers;
    rosterState.rawRows = result.rows;
    rosterState.idColumnHeader = null;
    rosterState.index = new Map();

    ui.setRosterStatus({ filename: rosterState.filename, rowCount: rosterState.rawRows.length, headers: rosterState.headers, selectedHeader: null });
    ui.setRosterControlsAvailability({ hasRows: rosterState.rawRows.length > 0, hasIdColumn: false });
    refreshExportControls();
    ui.showAppMessage('info', `Loaded ${rosterState.rawRows.length} roster row(s) from ${file.name}.`);
    schedulePersist();
  };
  reader.onerror = () => {
    ui.showAppMessage('error', `Failed to read file: ${file.name}`);
    diagnostics.logEvent('error', { kind: 'roster-file-read-failed', message: reader.error?.message });
  };
  reader.readAsText(file, 'utf-8');
});

elements.rosterIdColumnSelect.addEventListener('change', () => {
  const header = elements.rosterIdColumnSelect.value || null;
  rosterState.idColumnHeader = header;
  rosterState.index = header ? buildRosterIndex(rosterState.rawRows, header) : new Map();
  ui.setRosterControlsAvailability({ hasRows: rosterState.rawRows.length > 0, hasIdColumn: !!header });
  refreshExportControls();
  schedulePersist();
});

elements.clearRosterBtn.addEventListener('click', () => {
  rosterState.enabled = false;
  rosterState.filename = null;
  rosterState.headers = [];
  rosterState.rawRows = [];
  rosterState.idColumnHeader = null;
  rosterState.index = new Map();

  elements.rosterEnableToggle.checked = false;
  ui.setRosterStatus({ filename: null, rowCount: 0, headers: [], selectedHeader: null });
  ui.setRosterControlsAvailability({ hasRows: false, hasIdColumn: false });
  ui.renderStats(scanPipeline.getStats(), rosterState.enabled);
  refreshExportControls();
  schedulePersist();
});

elements.rosterEnableToggle.addEventListener('change', () => {
  if (elements.rosterEnableToggle.checked && !rosterState.idColumnHeader) {
    elements.rosterEnableToggle.checked = false;
    ui.showAppMessage('error', 'Select a University ID column before enabling roster checking.');
    diagnostics.logEvent('error', { kind: 'no-id-column-selected', message: 'Roster checking enable was blocked: no University ID column selected.' });
    return;
  }
  rosterState.enabled = elements.rosterEnableToggle.checked;
  ui.renderStats(scanPipeline.getStats(), rosterState.enabled);
  refreshExportControls();
  schedulePersist();
});

// ---- Attendance table / export -------------------------------------------------

elements.downloadCsvBtn.addEventListener('click', async () => {
  if (exportInFlight) return; // defensive; button is also disabled while in flight

  const rosterActive = rosterState.enabled && rosterState.index.size > 0;
  const mode = rosterActive ? elements.exportModeSelect.value : 'present';

  if (mode === 'present') {
    const result = downloadAttendanceCsv(scanPipeline.getRecords());
    if (!result.ok) {
      ui.showAppMessage('error', `CSV export failed: ${result.error}`);
    }
    return;
  }

  const myGeneration = ++exportGeneration;
  exportInFlight = true;
  ui.setExportInProgress(true);
  ui.setExportProgressText('Checking roster for absent students…');

  const scannedIds = new Set(
    scanPipeline
      .getRecords()
      .map((record) => record.universityId)
      .filter(Boolean)
      .map(normalizeId)
  );

  const absentRows = await computeAbsentRows({
    rosterState,
    scannedIds,
    cache: absentLookupCache,
    concurrency: ABSENT_LOOKUP_CONCURRENCY,
    onProgress: ({ done, total }) => {
      if (myGeneration !== exportGeneration) return;
      ui.setExportProgressText(`Looking up ${done} of ${total} absent students…`);
    },
    shouldAbort: () => myGeneration !== exportGeneration,
  });

  exportInFlight = false;
  ui.setExportInProgress(false);
  ui.setExportProgressText('');

  if (myGeneration !== exportGeneration) return; // roster changed mid-fetch: discard this result

  if (absentRows.length === 0) {
    ui.showAppMessage('info', 'No absent students found — everyone on the roster was scanned.');
  }

  const presentRecords = scanPipeline.getRecords();
  const combinedRecords = mode === 'absent' ? absentRows : [...presentRecords, ...absentRows];

  const result = downloadAttendanceCsv(combinedRecords);
  if (!result.ok) {
    ui.showAppMessage('error', `CSV export failed: ${result.error}`);
  }
});

elements.clearAllBtn.addEventListener('click', () => {
  if (scanPipeline.getRecords().length === 0) return;
  const confirmed = window.confirm('Clear all attendance records for this session? This cannot be undone.');
  if (!confirmed) return;
  scanPipeline.clearAll();
  ui.clearAttendanceTable();
  ui.resetLatestScanPanel();
  ui.renderStats(scanPipeline.getStats(), rosterState.enabled);
  schedulePersist();
});

// ---- Preferences: sound alerts, remember session, clear local data -------------

elements.soundAlertsToggle.addEventListener('change', () => {
  schedulePersist();
});

elements.rememberSessionToggle.addEventListener('change', () => {
  if (elements.rememberSessionToggle.checked && !storage.isStorageAvailable()) {
    elements.rememberSessionToggle.checked = false;
    ui.setStorageWarning(true);
    return;
  }
  if (elements.rememberSessionToggle.checked) {
    storage.saveSessionNow(buildPersistState());
  }
});

elements.clearLocalDataBtn.addEventListener('click', () => {
  storage.clearLocalData();
  elements.rememberSessionToggle.checked = false;
  ui.showAppMessage('info', 'Local data cleared from this computer.');
});

// ---- Diagnostics panel wiring -----------------------------------------------

elements.debugModeToggle.addEventListener('change', () => {
  ui.setDebugModeUI(elements.debugModeToggle.checked);
});

elements.copyDiagnosticsBtn.addEventListener('click', async () => {
  const text = diagnostics.toCopyText();
  try {
    await navigator.clipboard.writeText(text);
    ui.showAppMessage('info', 'Diagnostics copied to clipboard.');
  } catch {
    // Clipboard API unavailable or denied: fall back to a temporary
    // selectable textarea so the professor/developer can still copy manually.
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand('copy');
      ui.showAppMessage('info', 'Diagnostics copied to clipboard.');
    } catch {
      ui.showAppMessage('error', 'Could not copy diagnostics automatically. Select and copy the text manually.');
    }
    document.body.removeChild(textarea);
  }
});

elements.clearDiagnosticsBtn.addEventListener('click', () => {
  diagnostics.clear();
  ui.clearDiagLists();
});

// Live-mirror every 'error' diagnostics event (from any module) into the
// Diagnostics panel's visible error log, so failures inside lookup.js,
// roster.js, csv.js, storage.js, etc. are visible without each of those
// modules needing to know about ui.js.
diagnostics.setListener((event) => {
  if (event.category === 'error') {
    ui.addErrorLogEntry(event);
  }
});

// ---- Persistence --------------------------------------------------------------

function buildPersistState() {
  return {
    attendanceRecords: scanPipeline.getRecords(),
    duplicateCounters: scanPipeline.getDuplicateCounters(),
    roster: {
      filename: rosterState.filename,
      headers: rosterState.headers,
      rawRows: rosterState.rawRows,
      idColumnHeader: rosterState.idColumnHeader,
      enabled: rosterState.enabled,
    },
    preferences: {
      soundAlertsEnabled: elements.soundAlertsToggle.checked,
      rememberSession: elements.rememberSessionToggle.checked,
    },
  };
}

function schedulePersist() {
  if (!elements.rememberSessionToggle.checked) return;
  storage.saveSessionDebounced(buildPersistState());
}

function restoreFromSaved(saved) {
  rosterState.filename = saved.roster?.filename || null;
  rosterState.headers = saved.roster?.headers || [];
  rosterState.rawRows = saved.roster?.rawRows || [];
  rosterState.idColumnHeader = saved.roster?.idColumnHeader || null;
  rosterState.index = rosterState.idColumnHeader ? buildRosterIndex(rosterState.rawRows, rosterState.idColumnHeader) : new Map();
  rosterState.enabled = !!saved.roster?.enabled;

  ui.setRosterStatus({
    filename: rosterState.filename,
    rowCount: rosterState.rawRows.length,
    headers: rosterState.headers,
    selectedHeader: rosterState.idColumnHeader,
  });
  ui.setRosterControlsAvailability({ hasRows: rosterState.rawRows.length > 0, hasIdColumn: !!rosterState.idColumnHeader });
  elements.rosterEnableToggle.checked = rosterState.enabled;
  refreshExportControls();

  scanPipeline.restoreState({
    records: saved.attendanceRecords || [],
    duplicateCounters: saved.duplicateCounters || { suppressed: 0 },
  });
  ui.renderAllRecords(scanPipeline.getRecords(), handleRemoveRecord);
  ui.renderStats(scanPipeline.getStats(), rosterState.enabled);

  elements.soundAlertsToggle.checked = saved.preferences?.soundAlertsEnabled ?? true;
  elements.rememberSessionToggle.checked = true;
}

elements.restoreBtn.addEventListener('click', () => {
  const saved = storage.loadSession();
  if (saved) {
    restoreFromSaved(saved);
    ui.showAppMessage('info', 'Previous session restored.');
  }
  ui.showRestoreBanner(false);
});

elements.discardBtn.addEventListener('click', () => {
  storage.clearLocalData();
  ui.showRestoreBanner(false);
});

// ---- Startup -------------------------------------------------------------------

function initDiagnosticsSupportInfo() {
  const webHidSupported = isWebHidSupported();
  const secureContext = isSecureContext();
  ui.setDiagSupportInfo({ webHidSupported, secureContext });
  diagnostics.logEvent('webhid-support', { webHidSupported, secureContext, origin: window.location.origin });

  if (!webHidSupported) {
    ui.showAppMessage('error', HID_ERROR_MESSAGES['webhid-unavailable']);
  } else if (!secureContext) {
    ui.showAppMessage('error', HID_ERROR_MESSAGES['insecure-origin']);
  }
}

function initPreferencesDefaults() {
  elements.debugModeToggle.checked = DEBUG_MODE_DEFAULT;
  ui.setDebugModeUI(DEBUG_MODE_DEFAULT);

  if (!storage.isStorageAvailable()) {
    ui.setStorageWarning(true);
    // #storage-warning lives inside the (now collapsed-by-default)
    // Settings panel, so it's invisible until the user opens it. Also
    // surface it in the always-visible app-messages area so it can't be
    // missed at startup.
    ui.showAppMessage('warning', 'Local storage is unavailable in this browser session; "Remember this session" cannot be used.');
    elements.rememberSessionToggle.checked = false;
    elements.rememberSessionToggle.disabled = true;
    elements.clearLocalDataBtn.disabled = true;
  }
}

function initCredentials() {
  credentials.loadPersistedCredentials();
  const saved = credentials.getCredentials();
  ui.setCredentialsFields(saved);
  const hasCredentials = !!(saved.keyName && saved.key);
  ui.setCredentialsStatus(hasCredentials ? 'Saved.' : 'No credentials saved.');
  ui.setApiKeyWarning(!hasCredentials);
}

async function init() {
  initDiagnosticsSupportInfo();
  initPreferencesDefaults();
  initCredentials();
  ui.setDiagDeviceInfo(null);
  ui.renderStats(scanPipeline.getStats(), rosterState.enabled);

  if (storage.hasSavedSession()) {
    ui.showRestoreBanner(true);
  }

  // Attempt a silent reconnect to a reader the user has already
  // authorized in a previous visit. This does not show the device
  // chooser and requires no user gesture.
  await hidReader.reconnectKnownDevices();
}

init();
