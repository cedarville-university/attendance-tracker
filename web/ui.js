// ui.js
//
// All DOM rendering lives here. Functions in this module take plain data
// (a scan record, device info, roster info, ...) and update the DOM; they
// never decide business logic themselves -- e.g. this module does not
// compute rosterStatus, it only displays whatever scan-pipeline.js already
// decided. Untrusted strings (card codes, roster CSV headers/values, API
// response fields) are always written via textContent, never innerHTML, to
// avoid injecting markup from scanned/roster/API data.

export const elements = {
  connectBtn: document.getElementById('btn-connect'),
  disconnectBtn: document.getElementById('btn-disconnect'),
  readerStatusDot: document.getElementById('reader-status-dot'),
  readerStatusText: document.getElementById('reader-status-text'),
  readerProductName: document.getElementById('reader-product-name'),

  rosterEnableToggle: document.getElementById('roster-enable-toggle'),
  loadRosterBtn: document.getElementById('btn-load-roster'),
  rosterFileInput: document.getElementById('roster-file-input'),
  clearRosterBtn: document.getElementById('btn-clear-roster'),
  rosterFilename: document.getElementById('roster-filename'),
  rosterRowCount: document.getElementById('roster-row-count'),
  rosterIdColumnSelect: document.getElementById('roster-id-column-select'),

  latestScanPanel: document.getElementById('latest-scan-panel'),
  latestScanStatusText: document.getElementById('latest-scan-status-text'),
  latestScanName: document.getElementById('latest-scan-name'),
  latestScanUniversityId: document.getElementById('latest-scan-university-id'),
  latestScanCardCode: document.getElementById('latest-scan-card-code'),
  latestScanTime: document.getElementById('latest-scan-time'),

  statsTotal: document.getElementById('stats-total'),
  statsDuplicates: document.getElementById('stats-duplicates'),
  statsRosterGroup: document.getElementById('stats-roster-group'),
  statsExpected: document.getElementById('stats-expected'),
  statsUnexpected: document.getElementById('stats-unexpected'),
  statsLookupErrors: document.getElementById('stats-lookup-errors'),

  soundAlertsToggle: document.getElementById('sound-alerts-toggle'),
  rememberSessionToggle: document.getElementById('remember-session-toggle'),
  clearLocalDataBtn: document.getElementById('btn-clear-local-data'),
  storageWarning: document.getElementById('storage-warning'),

  downloadCsvBtn: document.getElementById('btn-download-csv'),
  clearAllBtn: document.getElementById('btn-clear-all'),
  exportModeSelect: document.getElementById('export-mode-select'),
  attendanceTableBody: document.getElementById('attendance-table-body'),
  attendanceEmptyMessage: document.getElementById('attendance-empty-message'),
  attendanceRowTemplate: document.getElementById('attendance-row-template'),

  diagnosticsPanel: document.getElementById('diagnostics-panel'),
  diagWebHidSupport: document.getElementById('diag-webhid-support'),
  diagSecureContext: document.getElementById('diag-secure-context'),
  diagProductName: document.getElementById('diag-product-name'),
  diagVendorId: document.getElementById('diag-vendor-id'),
  diagProductId: document.getElementById('diag-product-id'),
  diagOpened: document.getElementById('diag-opened'),
  diagCollections: document.getElementById('diag-collections'),
  debugModeToggle: document.getElementById('debug-mode-toggle'),
  diagRawReports: document.getElementById('diag-raw-reports'),
  diagErrorLog: document.getElementById('diag-error-log'),
  diagReportEntryTemplate: document.getElementById('diag-report-entry-template'),
  copyDiagnosticsBtn: document.getElementById('btn-copy-diagnostics'),
  clearDiagnosticsBtn: document.getElementById('btn-clear-diagnostics'),

  restoreBanner: document.getElementById('restore-session-banner'),
  restoreBtn: document.getElementById('btn-restore-session'),
  discardBtn: document.getElementById('btn-discard-session'),

  appMessages: document.getElementById('app-messages'),
};

const MAX_APP_MESSAGES = 5;
const MAX_VISIBLE_DIAG_ENTRIES = 50;

/** @param {string} isoTimestamp */
export function formatLocalTime(isoTimestamp) {
  try {
    return new Date(isoTimestamp).toLocaleString();
  } catch {
    return isoTimestamp;
  }
}

// ---- Reader status ----------------------------------------------------

export function setReaderStatus({ connected, device }) {
  elements.readerStatusDot.classList.toggle('status-dot--connected', connected);
  elements.readerStatusDot.classList.toggle('status-dot--disconnected', !connected);
  elements.readerStatusText.textContent = connected ? 'Connected' : 'Disconnected';
  elements.readerProductName.textContent = connected && device ? device.productName : 'No reader connected.';
  elements.connectBtn.disabled = connected;
  elements.disconnectBtn.disabled = !connected;
}

// ---- Roster status ------------------------------------------------------

export function populateRosterColumnOptions(headers, selectedHeader) {
  const select = elements.rosterIdColumnSelect;
  while (select.firstChild) select.removeChild(select.firstChild);

  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = headers.length ? 'Select a column…' : 'Load a roster CSV first';
  select.appendChild(placeholder);

  for (const header of headers) {
    const option = document.createElement('option');
    option.value = header;
    option.textContent = header;
    if (header === selectedHeader) option.selected = true;
    select.appendChild(option);
  }
  select.disabled = headers.length === 0;
}

export function setRosterStatus({ filename, rowCount, headers, selectedHeader }) {
  elements.rosterFilename.textContent = filename || 'None loaded';
  elements.rosterRowCount.textContent = String(rowCount);
  populateRosterColumnOptions(headers, selectedHeader);
}

export function setRosterControlsAvailability({ hasRows, hasIdColumn }) {
  elements.rosterEnableToggle.disabled = !(hasRows && hasIdColumn);
  elements.clearRosterBtn.disabled = !hasRows;
}

// ---- Export controls -------------------------------------------------------

/** Shows/hides the Present/Absent export mode selector -- only relevant when a roster is active. */
export function setExportControlsAvailability({ rosterActive }) {
  elements.exportModeSelect.hidden = !rosterActive;
  if (!rosterActive) elements.exportModeSelect.value = 'present';
}

// ---- Latest scan ---------------------------------------------------------

const LATEST_SCAN_STATUS_TEXT = {
  idle: 'Waiting for a card…',
  pending: 'Card scanned — looking up student…',
  expected: '✓ Expected student',
  unexpected: '⚠ UNEXPECTED STUDENT',
  'lookup-error': '⚠ Lookup error — could not verify roster status',
  unchecked: '✓ Scan recorded',
};

function studentDisplayName(record) {
  const parts = [record.lookupData?.firstName, record.lookupData?.lastName].filter(Boolean);
  return parts.length ? parts.join(' ') : null;
}

function applyLatestScanState(state, record) {
  elements.latestScanPanel.className = `panel latest-scan latest-scan--${state}`;
  elements.latestScanStatusText.textContent = LATEST_SCAN_STATUS_TEXT[state] || state;
  elements.latestScanName.textContent = studentDisplayName(record) || '—';
  elements.latestScanUniversityId.textContent = record.universityId || '—';
  elements.latestScanCardCode.textContent = record.rawCardCode || '—';
  elements.latestScanTime.textContent = formatLocalTime(record.timestamp);
}

export function renderLatestScanPending(record) {
  applyLatestScanState('pending', record);
}

export function renderLatestScanResult(record) {
  applyLatestScanState(record.rosterStatus, record);
}

export function resetLatestScanPanel() {
  elements.latestScanPanel.className = 'panel latest-scan latest-scan--idle';
  elements.latestScanStatusText.textContent = LATEST_SCAN_STATUS_TEXT.idle;
  elements.latestScanName.textContent = '—';
  elements.latestScanUniversityId.textContent = '—';
  elements.latestScanCardCode.textContent = '—';
  elements.latestScanTime.textContent = '—';
}

// ---- Session statistics ---------------------------------------------------

export function renderStats(stats, rosterEnabled) {
  elements.statsTotal.textContent = String(stats.totalAccepted);
  elements.statsDuplicates.textContent = String(stats.suppressedDuplicates);
  elements.statsRosterGroup.hidden = !rosterEnabled;
  if (rosterEnabled) {
    elements.statsExpected.textContent = String(stats.expected);
    elements.statsUnexpected.textContent = String(stats.unexpected);
    elements.statsLookupErrors.textContent = String(stats.lookupErrors);
  }
}

// ---- Attendance table -----------------------------------------------------

const STATUS_LABELS = {
  pending: 'Pending…',
  expected: 'Expected',
  unexpected: 'Unexpected',
  'lookup-error': 'Lookup error',
  unchecked: 'Unchecked',
};

function fillAttendanceRow(row, record) {
  row.querySelector('.col-time').textContent = formatLocalTime(record.timestamp);
  row.querySelector('.col-card-code').textContent = record.rawCardCode;
  row.querySelector('.col-university-id').textContent = record.universityId || '—';
  const name = studentDisplayName(record);
  row.querySelector('.col-name').textContent = name || (record.status === 'pending' ? 'Looking up…' : '—');
  const badge = row.querySelector('.status-badge');
  const state = record.rosterStatus || 'pending';
  badge.textContent = STATUS_LABELS[state] || state;
  badge.className = `status-badge status-badge--${state}`;
}

function updateEmptyMessage() {
  elements.attendanceEmptyMessage.hidden = elements.attendanceTableBody.children.length > 0;
}

/**
 * Adds a new row to the top of the table (newest-first display order).
 * @param {object} record
 * @param {(id: string) => void} onRemove
 */
export function addAttendanceRow(record, onRemove) {
  const fragment = elements.attendanceRowTemplate.content.cloneNode(true);
  const row = fragment.querySelector('tr');
  row.dataset.scanId = record.id;
  fillAttendanceRow(row, record);
  row.querySelector('.remove-row-button').addEventListener('click', () => onRemove(record.id));
  elements.attendanceTableBody.insertBefore(row, elements.attendanceTableBody.firstChild);
  updateEmptyMessage();
}

export function updateAttendanceRow(record) {
  const row = elements.attendanceTableBody.querySelector(`tr[data-scan-id="${record.id}"]`);
  if (row) fillAttendanceRow(row, record);
}

export function removeAttendanceRow(id) {
  const row = elements.attendanceTableBody.querySelector(`tr[data-scan-id="${id}"]`);
  if (row) row.remove();
  updateEmptyMessage();
}

export function clearAttendanceTable() {
  while (elements.attendanceTableBody.firstChild) {
    elements.attendanceTableBody.removeChild(elements.attendanceTableBody.firstChild);
  }
  updateEmptyMessage();
}

/**
 * Renders a full set of records (e.g. after restoring a saved session).
 * Records must be passed in creation order; this function preserves the
 * usual newest-first display order.
 */
export function renderAllRecords(records, onRemove) {
  clearAttendanceTable();
  for (const record of records) {
    addAttendanceRow(record, onRemove);
  }
}

// ---- Diagnostics / hardware-test panel -------------------------------------

export function setDiagSupportInfo({ webHidSupported, secureContext }) {
  elements.diagWebHidSupport.textContent = webHidSupported ? 'Yes' : 'No';
  elements.diagSecureContext.textContent = secureContext ? 'Yes' : 'No';
}

export function setDiagDeviceInfo(device) {
  if (!device) {
    elements.diagProductName.textContent = '—';
    elements.diagVendorId.textContent = '—';
    elements.diagProductId.textContent = '—';
    elements.diagOpened.textContent = '—';
    elements.diagCollections.textContent = 'No device connected.';
    return;
  }
  elements.diagProductName.textContent = device.productName || '—';
  elements.diagVendorId.textContent = device.vendorIdHex;
  elements.diagProductId.textContent = device.productIdHex;
  elements.diagOpened.textContent = device.opened ? 'Yes' : 'No';
  elements.diagCollections.textContent = JSON.stringify(device.collections, null, 2);
}

function addDiagEntry(container, { title, timestamp, hexLine, detailLine }) {
  const fragment = elements.diagReportEntryTemplate.content.cloneNode(true);
  const entry = fragment.querySelector('.diag-report-entry');
  entry.querySelector('.diag-report-id').textContent = title;
  entry.querySelector('.diag-report-timestamp').textContent = timestamp;
  entry.querySelector('.diag-report-hex').textContent = hexLine || '';
  entry.querySelector('.diag-report-parsed').textContent = detailLine || '';
  container.insertBefore(entry, container.firstChild);
  while (container.children.length > MAX_VISIBLE_DIAG_ENTRIES) {
    container.removeChild(container.lastChild);
  }
}

/** @param {import('./omnikey-parser.js').OmnikeyParseResult} parsed */
export function addRawReportEntry(parsed) {
  addDiagEntry(elements.diagRawReports, {
    title: `Report ID ${parsed.reportId ?? '—'}${parsed.lengthWasImplausible ? ' (length fallback used)' : ''}`,
    timestamp: parsed.timestamp,
    hexLine: `hex: ${parsed.rawHex}`,
    detailLine: `len=${parsed.declaredLength} ver=${parsed.version} ascii="${parsed.asciiString}" cardCode="${parsed.trimmedCardCode}" valid=${parsed.valid} hasPayload=${parsed.hasPayload}`,
  });
}

export function addErrorLogEntry({ timestamp, category, detail }) {
  addDiagEntry(elements.diagErrorLog, {
    title: category,
    timestamp,
    detailLine: typeof detail === 'string' ? detail : JSON.stringify(detail),
  });
}

export function clearDiagLists() {
  while (elements.diagRawReports.firstChild) elements.diagRawReports.removeChild(elements.diagRawReports.firstChild);
  while (elements.diagErrorLog.firstChild) elements.diagErrorLog.removeChild(elements.diagErrorLog.firstChild);
}

export function setDebugModeUI(enabled) {
  elements.diagRawReports.hidden = !enabled;
}

// ---- Restore-session banner -------------------------------------------------

export function showRestoreBanner(show) {
  elements.restoreBanner.hidden = !show;
}

// ---- Global app messages / storage warning ------------------------------------

export function showAppMessage(kind, text) {
  const div = document.createElement('div');
  div.className = `app-message app-message--${kind}`;
  div.textContent = text;
  elements.appMessages.insertBefore(div, elements.appMessages.firstChild);
  while (elements.appMessages.children.length > MAX_APP_MESSAGES) {
    elements.appMessages.removeChild(elements.appMessages.lastChild);
  }
  if (kind === 'info') {
    setTimeout(() => div.remove(), 8000);
  }
}

export function setStorageWarning(show) {
  elements.storageWarning.hidden = !show;
}
