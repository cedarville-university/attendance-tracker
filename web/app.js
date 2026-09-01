// app.js
//
// Orchestration only: wires DOM events to the pipeline/roster/hid modules,
// owns the small amount of top-level mutable state that doesn't belong to
// any single module (roster selection state, the AudioContext), and calls
// ui.js to render on every state change. No HID parsing, lookup, roster
// matching, CSV, or storage logic lives in this file -- it delegates to
// the dedicated modules for all of that.

import { DEBUG_MODE_DEFAULT } from './config.js';
import * as diagnostics from './diagnostics.js';
import { HidReader, isWebHidSupported, isSecureContext } from './hid-reader.js';
import { loadRosterCsv, buildRosterIndex, normalizeId } from './roster.js';
import {
  fetchCourseRoster,
  refreshCourseRoster,
  buildMemberIndex,
  countEligible,
} from './course-roster.js';
import { ScanPipeline } from './scan-pipeline.js';
import { downloadAttendanceCsv, downloadCsvText } from './csv.js';
import { computeAbsentRows, computeAbsentRowsFromMembers } from './absentees.js';
import { eligibleUnrecordedMembers } from './manual-present.js';
import { bindInlineConfirm } from './confirm-inline.js';
import * as storage from './storage.js';
import * as ui from './ui.js';
import { bootstrapSession } from './api-client.js';
import {
  createAttendanceSession,
  closeAttendanceSession,
  reopenAttendanceSession,
  retryGradeSync,
  getAttendanceSession,
  listOpenAttendanceSessions,
  deleteAttendanceRecord,
  correctMemberStatus,
  fetchAttendanceCsv,
} from './attendance-session.js';

const { elements } = ui;

// ---- Attendance session state (owned here) --------------------------------

let currentAttendanceSessionId = null;

// The open session's roster snapshot (GET /api/attendance-sessions/:id members[]),
// used to drive the manual "mark present" picker. Empty until a session is
// started or resumed.
let sessionMembers = [];

/** Re-renders the manual-present dropdown from the current sessionMembers snapshot. */
function refreshManualPresentOptions() {
  ui.renderManualPresentOptions(eligibleUnrecordedMembers(sessionMembers));
}

/**
 * Reflects a member reaching `present` (via a scan or a manual mark) into the
 * local sessionMembers snapshot so they drop out of the picker.
 */
function noteMemberPresent(ltiUserId, record) {
  if (!ltiUserId) return;
  const member = sessionMembers.find((m) => m.ltiUserId === ltiUserId);
  if (member) {
    member.currentRecord = record || member.currentRecord || { status: 'present' };
    refreshManualPresentOptions();
  }
}

// ---- Roster state (owned here; roster.js only provides pure helpers) ------

const rosterState = {
  enabled: false,
  filename: null,
  headers: [],
  rawRows: [],
  idColumnHeader: null,
  index: new Map(),
};

// ---- Canvas roster state (owned here; course-roster.js provides pure helpers) ----

const canvasRosterState = {
  members: [],
  index: new Map(), // normalized institutional ID -> CanvasRosterMember
  fetchedAt: null,
  stale: false,
  loaded: false,
};

async function loadCanvasRoster({ refresh = false } = {}) {
  elements.refreshRosterBtn.disabled = true;
  ui.showCanvasRosterLoading();
  const result = refresh ? await refreshCourseRoster() : await fetchCourseRoster();
  if (!result.ok) {
    ui.renderCanvasRosterError(result.error);
    diagnostics.logEvent('error', {
      kind: 'canvas-roster-load-failed',
      message: result.error.message,
    });
    return;
  }
  canvasRosterState.members = result.members;
  canvasRosterState.index = buildMemberIndex(result.members);
  canvasRosterState.fetchedAt = result.fetchedAt;
  canvasRosterState.stale = result.stale;
  canvasRosterState.loaded = true;
  ui.renderCanvasRoster(result);
  ui.setRosterCountText(countEligible(result.members));
  refreshExportControls();
}

// ---- Scan pipeline ----------------------------------------------------------

// Rows added by a session resume (C1) are not tracked by scanPipeline; keep a
// side map so their DELETE call can find the server ids.
const resumedRowsById = new Map();

async function handleRemoveRecord(recordOrId) {
  // ui.js now passes the full record; tolerate a bare id for safety.
  const record =
    typeof recordOrId === 'string'
      ? scanPipeline.getRecords().find((r) => r.id === recordOrId) ||
        resumedRowsById.get(recordOrId) || { id: recordOrId }
      : recordOrId;

  // Server-authoritative deletion is only possible for a rostered row (the
  // DELETE route is member-scoped). Unexpected / lookup-error rows fall back to
  // a client-only removal.
  if (currentAttendanceSessionId && record.serverRecordId && record.ltiUserId) {
    const result = await deleteAttendanceRecord(
      currentAttendanceSessionId,
      record.ltiUserId,
      record.serverRecordId,
    );
    if (!result.ok) {
      ui.showAppMessage('error', `Could not remove the record: ${result.error.message}`);
      return; // keep the row
    }
  }

  scanPipeline.removeRecord(record.id);
  resumedRowsById.delete(record.id);
  ui.removeAttendanceRow(record.id);
  schedulePersist();
}

const scanPipeline = new ScanPipeline({
  sessionId: null, // set once Start Attendance succeeds; see startSession() below
  callbacks: {
    onRecordCreated: (record) => {
      ui.addAttendanceRow(record, handleRemoveRecord);
      ui.renderLatestScanPending(record);
      if (record.status === 'present') noteMemberPresent(record.ltiUserId, record);
      schedulePersist();
    },
    onRecordUpdated: (record) => {
      ui.updateAttendanceRow(record);
      if (record.status === 'present') noteMemberPresent(record.ltiUserId, record);
      schedulePersist();
    },
    onLatestScanUpdate: (record) => {
      ui.renderLatestScanResult(record);
      if (record.status === 'unexpected' && elements.soundAlertsToggle.checked) {
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
  'webhid-unavailable':
    'This browser does not support WebHID. Use a recent desktop Chrome or Edge.',
  'insecure-origin':
    'This page must be served over HTTPS or from localhost to use the card reader.',
  'permission-denied':
    'Reader access was denied, or the device chooser was closed without selecting a reader.',
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
      diagnostics.logEvent('raw-report', {
        reportId: parsed.reportId,
        rawHex: parsed.rawHex,
        timestamp: parsed.timestamp,
      });
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
    if (connected) noteReaderConnected();
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
  { once: true },
);

// ---- First-run hint ------------------------------------------------------------

// One quiet line under the control bar, retired for good once the reader has
// connected at least once (this visit or a previous one).
const CONNECTED_BEFORE_KEY = 'attendance:connected-before';

function hasConnectedBefore() {
  if (!storage.isStorageAvailable()) return false;
  try {
    return localStorage.getItem(CONNECTED_BEFORE_KEY) === '1';
  } catch {
    return false;
  }
}

function noteReaderConnected() {
  elements.firstRunHint.hidden = true;
  if (!storage.isStorageAvailable()) return;
  try {
    localStorage.setItem(CONNECTED_BEFORE_KEY, '1');
  } catch {
    // Non-fatal: the hint just reappears on the next fresh load.
  }
}

// ---- Reader connect / disconnect buttons -----------------------------------

elements.connectBtn.addEventListener('click', async () => {
  ensureAudioContext();
  ui.setReaderConnecting();
  try {
    await hidReader.connect();
  } catch {
    // Message already surfaced via the onError callback; just clear the
    // transient "Connecting…" state back to disconnected.
    ui.setReaderStatus({ connected: false });
  }
});

elements.disconnectBtn.addEventListener('click', () => {
  hidReader.disconnect();
});

// ---- Attendance session lifecycle ------------------------------------------

async function startSession() {
  elements.startSessionBtn.disabled = true;
  const result = await createAttendanceSession({});
  if (!result.ok) {
    elements.startSessionBtn.disabled = false;
    ui.showAppMessage('error', `Could not start attendance: ${result.error.message}`);
    return;
  }
  currentAttendanceSessionId = result.session.id;
  scanPipeline.sessionId = result.session.id;
  ui.renderSessionState({ state: result.session.state, label: result.session.label });
  ui.showAppMessage('info', 'Attendance session started.');

  // The POST returns only the bare session row; fetch the detail once so the
  // manual "mark present" picker has the roster snapshot to work from.
  const detail = await getAttendanceSession(currentAttendanceSessionId);
  sessionMembers = detail.ok ? detail.body.members || [] : [];
  ui.setManualPresentGroupVisible(true);
  refreshManualPresentOptions();
}

async function closeSession() {
  if (!currentAttendanceSessionId) return;
  elements.closeSessionBtn.disabled = true;
  const result = await closeAttendanceSession(currentAttendanceSessionId);
  if (!result.ok) {
    elements.closeSessionBtn.disabled = false;
    ui.showAppMessage('error', `Could not close attendance: ${result.error.message}`);
    return;
  }
  ui.renderSessionState({ state: 'closed' });
  ui.setManualPresentGroupVisible(false);
  ui.showAppMessage('info', 'Attendance session closed. Unscanned students were marked absent.');
  await refreshGradeSync(currentAttendanceSessionId);
}

/** Re-fetches the session so the grade-sync panel reflects the latest job state. */
async function refreshGradeSync(sessionId) {
  if (!sessionId) return;
  const detail = await getAttendanceSession(sessionId);
  if (detail.ok) ui.renderGradeSyncState(detail.body?.gradeSync);
}

async function reopenSession() {
  if (!currentAttendanceSessionId) return;
  const reason = window.prompt('Reason for reopening this session (optional):') || undefined;
  elements.reopenSessionBtn.disabled = true;
  const result = await reopenAttendanceSession(currentAttendanceSessionId, reason);
  if (!result.ok) {
    elements.reopenSessionBtn.disabled = false;
    ui.showAppMessage('error', `Could not reopen attendance: ${result.error.message}`);
    return;
  }
  ui.renderSessionState({ state: 'reopened' });
  // Reopening doesn't touch grade-sync jobs; hide the panel until the next close.
  ui.renderGradeSyncState(undefined);
  ui.setManualPresentGroupVisible(true);
  refreshManualPresentOptions();
  ui.showAppMessage('info', 'Attendance session reopened. Scans are accepted again.');
}

elements.startSessionBtn.addEventListener('click', startSession);
elements.closeSessionBtn.addEventListener('click', closeSession);
elements.reopenSessionBtn.addEventListener('click', reopenSession);

// Manual "mark present" -- records a rostered student who has no scan (forgot
// their card). Reuses the same PATCH member endpoint as the per-row correction.
elements.manualPresentBtn.addEventListener('click', async () => {
  const ltiUserId = elements.manualPresentSelect.value;
  if (!currentAttendanceSessionId || !ltiUserId) return;
  const member = sessionMembers.find((m) => m.ltiUserId === ltiUserId);
  elements.manualPresentBtn.disabled = true;
  const result = await correctMemberStatus(currentAttendanceSessionId, ltiUserId, 'present');
  if (!result.ok) {
    ui.showAppMessage('error', `Could not mark present: ${result.error.message}`);
    refreshManualPresentOptions(); // restores the button's enabled state
    return;
  }
  const row = serverRecordToRow(result.record, member);
  resumedRowsById.set(row.id, row);
  ui.addAttendanceRow(row, handleRemoveRecord);
  // noteMemberPresent -> refreshManualPresentOptions owns the button state from here (it stays
  // disabled when nobody eligible is left).
  noteMemberPresent(ltiUserId, result.record);
  refreshManualPresentOptions();
  ui.showAppMessage('info', `Marked ${(member && member.displayName) || ltiUserId} present.`);
});

elements.retryGradeSyncBtn.addEventListener('click', async () => {
  const sessionId = currentAttendanceSessionId;
  if (!sessionId) return;
  elements.retryGradeSyncBtn.disabled = true;
  try {
    const result = await retryGradeSync(sessionId);
    if (!result.ok) ui.showAppMessage('error', 'Could not re-queue grade sync.');
    await refreshGradeSync(sessionId);
  } finally {
    elements.retryGradeSyncBtn.disabled = false;
  }
});

// ---- Roster wiring ------------------------------------------------------------

// Called after any change to rosterState (load/column-select/clear/enable):
// refreshes whether the Present/Absent export mode selector is shown.
function refreshExportControls() {
  const rosterActive =
    (canvasRosterState.loaded && canvasRosterState.index.size > 0) ||
    (rosterState.enabled && rosterState.index.size > 0);
  ui.setExportControlsAvailability({ rosterActive });
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

    ui.setRosterStatus({
      filename: rosterState.filename,
      rowCount: rosterState.rawRows.length,
      headers: rosterState.headers,
      selectedHeader: null,
    });
    ui.setRosterControlsAvailability({
      hasRows: rosterState.rawRows.length > 0,
      hasIdColumn: false,
    });
    refreshExportControls();
    ui.showAppMessage(
      'info',
      `Loaded ${rosterState.rawRows.length} roster row(s) from ${file.name}.`,
    );
    schedulePersist();
  };
  reader.onerror = () => {
    ui.showAppMessage('error', `Failed to read file: ${file.name}`);
    diagnostics.logEvent('error', {
      kind: 'roster-file-read-failed',
      message: reader.error?.message,
    });
  };
  reader.readAsText(file, 'utf-8');
});

elements.rosterIdColumnSelect.addEventListener('change', () => {
  const header = elements.rosterIdColumnSelect.value || null;
  rosterState.idColumnHeader = header;
  rosterState.index = header ? buildRosterIndex(rosterState.rawRows, header) : new Map();
  ui.setRosterControlsAvailability({
    hasRows: rosterState.rawRows.length > 0,
    hasIdColumn: !!header,
  });
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
    diagnostics.logEvent('error', {
      kind: 'no-id-column-selected',
      message: 'Roster checking enable was blocked: no University ID column selected.',
    });
    return;
  }
  rosterState.enabled = elements.rosterEnableToggle.checked;
  ui.renderStats(scanPipeline.getStats(), rosterState.enabled);
  refreshExportControls();
  schedulePersist();
});

elements.refreshRosterBtn.addEventListener('click', () => {
  loadCanvasRoster({ refresh: true });
});

// ---- Attendance table / export -------------------------------------------------

elements.downloadCsvBtn.addEventListener('click', async () => {
  // With a persisted session active, the server holds the authoritative record
  // (roster snapshot, system_absence rows, manual corrections). Download that.
  if (currentAttendanceSessionId) {
    const result = await fetchAttendanceCsv(currentAttendanceSessionId);
    if (!result.ok) {
      ui.showAppMessage('error', `CSV export failed: ${result.error.message}`);
      return;
    }
    const dl = downloadCsvText(result.csv, result.filename);
    if (!dl.ok) ui.showAppMessage('error', `CSV export failed: ${dl.error}`);
    return;
  }

  const canvasRosterActive = canvasRosterState.loaded && canvasRosterState.index.size > 0;
  const csvRosterActive = rosterState.enabled && rosterState.index.size > 0;
  const rosterActive = canvasRosterActive || csvRosterActive;
  const mode = rosterActive ? elements.exportModeSelect.value : 'present';
  const presentRecords = scanPipeline.getRecords();

  if (mode === 'present') {
    const result = downloadAttendanceCsv(presentRecords);
    if (!result.ok) {
      ui.showAppMessage('error', `CSV export failed: ${result.error}`);
    }
    return;
  }

  const scannedIds = new Set(
    presentRecords
      .map((record) => record.institutionalId)
      .filter(Boolean)
      .map(normalizeId),
  );
  const absentRows = canvasRosterActive
    ? computeAbsentRowsFromMembers({ memberIndex: canvasRosterState.index, scannedIds })
    : computeAbsentRows({ rosterState, scannedIds });

  if (absentRows.length === 0) {
    ui.showAppMessage('info', 'No absent students found — everyone on the roster was scanned.');
  }

  const combinedRecords = mode === 'absent' ? absentRows : [...presentRecords, ...absentRows];

  const result = downloadAttendanceCsv(combinedRecords);
  if (!result.ok) {
    ui.showAppMessage('error', `CSV export failed: ${result.error}`);
  }
});

bindInlineConfirm(elements.clearAllBtn, {
  armedLabel: 'Click again to clear',
  canArm: () => scanPipeline.getRecords().length > 0,
  onConfirm: () => {
    scanPipeline.clearAll();
    ui.clearAttendanceTable();
    ui.resetLatestScanPanel();
    ui.renderStats(scanPipeline.getStats(), rosterState.enabled);
    schedulePersist();
  },
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
      ui.showAppMessage(
        'error',
        'Could not copy diagnostics automatically. Select and copy the text manually.',
      );
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
    // Fast-path hint only; the server's open-session list is the source of truth
    // on reload (a persisted id the server no longer reports open is discarded).
    currentAttendanceSessionId,
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
  rosterState.index = rosterState.idColumnHeader
    ? buildRosterIndex(rosterState.rawRows, rosterState.idColumnHeader)
    : new Map();
  rosterState.enabled = !!saved.roster?.enabled;

  ui.setRosterStatus({
    filename: rosterState.filename,
    rowCount: rosterState.rawRows.length,
    headers: rosterState.headers,
    selectedHeader: rosterState.idColumnHeader,
  });
  ui.setRosterControlsAvailability({
    hasRows: rosterState.rawRows.length > 0,
    hasIdColumn: !!rosterState.idColumnHeader,
  });
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
  diagnostics.logEvent('webhid-support', {
    webHidSupported,
    secureContext,
    origin: window.location.origin,
  });

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
    // #storage-warning lives inside the collapsed-by-default setup panel,
    // so it's invisible until the user opens it. Also surface it in the
    // always-visible app-messages area so it can't be missed at startup.
    ui.showAppMessage(
      'warning',
      'This browser can’t save data, so “Remember this session on this computer” is turned off.',
    );
    elements.rememberSessionToggle.checked = false;
    elements.rememberSessionToggle.disabled = true;
    elements.clearLocalDataBtn.disabled = true;
  }
}

// C2: per-row manual-correction control -> PATCH the member. Returns true on
// success so ui.js can re-render that row's status badge.
ui.setManualCorrectionHandler(async (record, status) => {
  if (!currentAttendanceSessionId || !record.ltiUserId) return false;
  const result = await correctMemberStatus(currentAttendanceSessionId, record.ltiUserId, status);
  if (!result.ok) {
    ui.showAppMessage('error', `Could not update attendance: ${result.error.message}`);
    return false;
  }
  record.status = status;
  ui.showAppMessage('info', 'Attendance updated.');
  return true;
});

/**
 * Maps a server current-record / unmatched-record into the row-model shape the
 * attendance table + handleRemoveRecord expect.
 */
function serverRecordToRow(serverRecord, member) {
  return {
    id: `resume-${serverRecord.id}`,
    serverRecordId: serverRecord.id,
    timestamp: serverRecord.scannedAt || '',
    rawCardCode: '',
    institutionalId: (member && member.institutionalId) || serverRecord.institutionalId || null,
    ltiUserId: (member && member.ltiUserId) || null,
    displayName: (member && member.displayName) || null,
    clientScanId: null,
    status: serverRecord.status,
  };
}

async function resumeOpenSessionIfAny() {
  const list = await listOpenAttendanceSessions();
  if (!list.ok) {
    diagnostics.logEvent('error', { kind: 'resume-list-failed', message: list.error.message });
    return;
  }
  if (list.sessions.length === 0) return; // no open session; normal first-run path

  const hintId = storage.loadSession()?.currentAttendanceSessionId || null;
  const chosen = list.sessions.find((s) => s.id === hintId) || list.sessions[0];

  currentAttendanceSessionId = chosen.id;
  scanPipeline.sessionId = chosen.id;

  const detail = await getAttendanceSession(chosen.id);
  if (detail.ok) {
    sessionMembers = detail.body.members || [];
    resumedRowsById.clear();
    ui.clearAttendanceTable();
    const rows = [];
    for (const member of detail.body.members || []) {
      if (member.currentRecord) rows.push(serverRecordToRow(member.currentRecord, member));
    }
    for (const unmatched of detail.body.unmatchedRecords || []) {
      rows.push(serverRecordToRow(unmatched, null));
    }
    // Oldest first so addAttendanceRow's newest-on-top insert leaves the table
    // in a sensible order.
    rows.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
    for (const row of rows) {
      resumedRowsById.set(row.id, row);
      ui.addAttendanceRow(row, handleRemoveRecord);
    }
  } else {
    ui.showAppMessage(
      'warning',
      'Reconnected to the open attendance session, but its current roster could not be loaded.',
    );
  }

  ui.renderSessionState({ state: chosen.state, label: chosen.label });
  ui.renderGradeSyncState(detail.body?.gradeSync);
  ui.setManualPresentGroupVisible(true);
  refreshManualPresentOptions();
  ui.showAppMessage('info', 'Reconnected to the attendance session already in progress.');
}

async function init() {
  initDiagnosticsSupportInfo();
  initPreferencesDefaults();
  if (hasConnectedBefore()) elements.firstRunHint.hidden = true;
  ui.setDiagDeviceInfo(null);
  ui.renderStats(scanPipeline.getStats(), rosterState.enabled);

  // Bootstrap the CSRF token from GET /api/me before any mutation can fire.
  // On failure, leave Start Attendance disabled so no request goes out
  // without the x-csrf-token header the server's requireCsrf demands.
  const boot = await bootstrapSession();
  ui.renderSessionState({ state: 'none' });
  if (!boot.ok) {
    ui.showAppMessage('error', 'Could not load your session. Reload the page from Canvas.');
    // renderSessionState({state:'none'}) enables the Start button; re-disable
    // it here so no mutation goes out without a CSRF token.
    elements.startSessionBtn.disabled = true;
  } else {
    ui.renderCourseContext(boot.me);
    // C1: resume an attendance session that is still open on the server (page
    // reload / Canvas re-launch) instead of silently dropping every scan or
    // creating a duplicate open session -- must run before the Canvas roster
    // fetch (which can block on a live NRPS call) so the duplicate-open-session
    // guard isn't delayed behind it.
    await resumeOpenSessionIfAny();
    await loadCanvasRoster();
  }

  if (storage.hasSavedSession()) {
    ui.showRestoreBanner(true);
  }

  // Attempt a silent reconnect to a reader the user has already
  // authorized in a previous visit. This does not show the device
  // chooser and requires no user gesture.
  await hidReader.reconnectKnownDevices();
}

init();
