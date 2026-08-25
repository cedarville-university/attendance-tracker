// scan-pipeline.js
//
// Orchestrates turning a parsed HID report into an attendance scan record:
// duplicate suppression, record creation, the (un-awaited) card lookup,
// roster matching, and race-safe correlation of a late-arriving lookup
// response back to the correct record. This is the most
// correctness-critical module in the app -- see the "Concurrency
// correctness" requirement in the project spec -- so it is kept separate
// from both hid-reader.js (dumb transport) and ui.js (dumb rendering).
//
// Records are stored internally in creation order; display ordering
// (newest-first) is a UI concern handled by ui.js, not decided here.

import { DUPLICATE_SUPPRESS_WINDOW_MS } from './config.js';
import { logEvent } from './diagnostics.js';
import { lookupCard } from './lookup.js';
import { isExpected, getRosterRow } from './roster.js';

/**
 * @typedef {Object} ScanRecord
 * @property {string} id
 * @property {string} timestamp - ISO 8601.
 * @property {string} rawCardCode
 * @property {string|null} universityId
 * @property {Record<string, any>} lookupData - normalized lookup fields (empty on failure).
 * @property {Record<string, any>} rosterData - the full matched roster CSV row, if any.
 * @property {'pending'|'expected'|'unexpected'|'lookup-error'|'unchecked'} rosterStatus
 * @property {'pending'|'accepted'|'lookup-error'} status
 */

function emptyStats(suppressedDuplicates = 0) {
  return { totalAccepted: 0, expected: 0, unexpected: 0, lookupErrors: 0, suppressedDuplicates };
}

export class ScanPipeline {
  /**
   * @param {Object} options
   * @param {() => {enabled: boolean, index: Map<string, object>}} options.getRosterState
   * @param {Object} options.callbacks
   * @param {(record: ScanRecord) => void} options.callbacks.onRecordCreated
   * @param {(record: ScanRecord) => void} options.callbacks.onRecordUpdated
   * @param {(record: ScanRecord) => void} options.callbacks.onLatestScanUpdate - only fired when the resolving scan is still the most recently created one
   * @param {(stats: object) => void} options.callbacks.onStatsChanged
   */
  constructor({ getRosterState, callbacks }) {
    this.getRosterState = getRosterState;
    this.callbacks = callbacks;

    /** @type {ScanRecord[]} */
    this.records = [];
    /** @type {Map<string, ScanRecord>} */
    this.recordsById = new Map();
    /** @type {Map<string, number>} last-accepted timestamp (ms) per card code, for duplicate suppression */
    this.lastAcceptedByCode = new Map();
    this.latestScanId = null;
    this.nextId = 1;
    this.stats = emptyStats();
  }

  /**
   * Entry point for every parsed HID report. Filters out invalid packets
   * and data-less reports (Card In/Out/prestroke/poststroke) before a
   * candidate scan is ever considered.
   * @param {import('./omnikey-parser.js').OmnikeyParseResult} parsed
   */
  handleParsedReport(parsed) {
    if (!parsed.valid) {
      logEvent('error', { kind: 'invalid-hid-packet', message: parsed.note });
      return;
    }
    if (!parsed.hasPayload) {
      return; // Card In/Out/prestroke/poststroke or other non-data report; not an error.
    }
    this._processCandidateScan(parsed.trimmedCardCode);
  }

  /** @private */
  _processCandidateScan(cardCode) {
    const now = Date.now();
    const lastAccepted = this.lastAcceptedByCode.get(cardCode);
    if (lastAccepted !== undefined && now - lastAccepted < DUPLICATE_SUPPRESS_WINDOW_MS) {
      this.stats.suppressedDuplicates += 1;
      logEvent('duplicate-suppressed', { cardCode, withinMs: now - lastAccepted });
      this.callbacks.onStatsChanged(this.getStats());
      return;
    }
    // Mark as accepted immediately (before the lookup even starts) so a
    // burst of repeated taps while the first lookup is still in flight is
    // still correctly suppressed.
    this.lastAcceptedByCode.set(cardCode, now);

    const rosterState = this.getRosterState();
    /** @type {ScanRecord} */
    const record = {
      id: `scan-${this.nextId++}`,
      timestamp: new Date().toISOString(),
      rawCardCode: cardCode,
      universityId: null,
      lookupData: {},
      rosterData: {},
      rosterStatus: rosterState.enabled ? 'pending' : 'unchecked',
      status: 'pending',
    };

    this.records.push(record);
    this.recordsById.set(record.id, record);
    this.latestScanId = record.id;

    this.callbacks.onRecordCreated(record);

    // Deliberately not awaited: the caller (hid-reader's report handler)
    // must return immediately so the next inputreport -- possibly a
    // different card -- is never blocked behind this lookup.
    this._resolveScan(record.id, cardCode);
  }

  /** @private */
  async _resolveScan(scanId, cardCode) {
    const result = await lookupCard(cardCode);

    // The record may have been deleted (e.g. the professor removed the
    // row, or cleared the session) while the lookup was in flight.
    const record = this.recordsById.get(scanId);
    if (!record) return;

    record.universityId = result.universityId;
    record.lookupData = result.ok
      ? { firstName: result.firstName, lastName: result.lastName, email: result.email }
      : {};

    const rosterState = this.getRosterState();
    if (!result.ok) {
      record.status = 'lookup-error';
      record.rosterStatus = 'lookup-error'; // never claim "not on roster" when we couldn't even determine an ID
      this.stats.lookupErrors += 1;
    } else {
      record.status = 'accepted';
      this.stats.totalAccepted += 1;
      if (rosterState.enabled) {
        if (isExpected(rosterState.index, result.universityId)) {
          record.rosterStatus = 'expected';
          record.rosterData = getRosterRow(rosterState.index, result.universityId) || {};
          this.stats.expected += 1;
        } else {
          record.rosterStatus = 'unexpected';
          this.stats.unexpected += 1;
        }
      } else {
        record.rosterStatus = 'unchecked';
      }
    }

    // Always update this scan's own row, regardless of recency.
    this.callbacks.onRecordUpdated(record);
    this.callbacks.onStatsChanged(this.getStats());

    // Only touch the prominent "latest scan" panel (and by extension any
    // sound alert) if no newer scan has started since this one did -- this
    // is what stops a slow, older lookup from clobbering a fresher scan's
    // display.
    if (scanId === this.latestScanId) {
      this.callbacks.onLatestScanUpdate(record);
    }
  }

  /** @returns {object} a copy of the current session statistics */
  getStats() {
    return { ...this.stats };
  }

  /** @returns {ScanRecord[]} all records, in creation order */
  getRecords() {
    return this.records.slice();
  }

  /** @returns {{suppressed: number}} */
  getDuplicateCounters() {
    return { suppressed: this.stats.suppressedDuplicates };
  }

  /**
   * Removes a single record (professor correcting a mistake).
   * @param {string} id
   * @returns {boolean} whether a record was found and removed
   */
  removeRecord(id) {
    const index = this.records.findIndex((r) => r.id === id);
    if (index === -1) return false;
    const [removed] = this.records.splice(index, 1);
    this.recordsById.delete(id);
    this._decrementStatsForRecord(removed);
    if (this.latestScanId === id) {
      this.latestScanId = this.records.length ? this.records[this.records.length - 1].id : null;
    }
    this.callbacks.onStatsChanged(this.getStats());
    return true;
  }

  /** @private */
  _decrementStatsForRecord(record) {
    if (record.status === 'accepted') this.stats.totalAccepted -= 1;
    if (record.status === 'lookup-error') this.stats.lookupErrors -= 1;
    if (record.rosterStatus === 'expected') this.stats.expected -= 1;
    if (record.rosterStatus === 'unexpected') this.stats.unexpected -= 1;
  }

  /** Clears the entire session (professor confirmed via the UI first). */
  clearAll() {
    this.records = [];
    this.recordsById.clear();
    this.lastAcceptedByCode.clear();
    this.latestScanId = null;
    this.stats = emptyStats();
    this.callbacks.onStatsChanged(this.getStats());
  }

  /**
   * Hydrates pipeline state from a previously saved session (see
   * storage.js). Recomputes statistics from the restored records rather
   * than trusting stored counters, except for the suppressed-duplicate
   * count, which has no other source of truth.
   * @param {{records: ScanRecord[], duplicateCounters: {suppressed: number}}} saved
   */
  restoreState({ records, duplicateCounters }) {
    this.records = records || [];
    this.recordsById = new Map(this.records.map((r) => [r.id, r]));
    this.latestScanId = this.records.length ? this.records[this.records.length - 1].id : null;

    let maxSeen = 0;
    for (const record of this.records) {
      const match = /^scan-(\d+)$/.exec(record.id);
      if (match) maxSeen = Math.max(maxSeen, Number(match[1]));
    }
    this.nextId = maxSeen + 1;

    const stats = emptyStats((duplicateCounters && duplicateCounters.suppressed) || 0);
    for (const record of this.records) {
      if (record.status === 'accepted') stats.totalAccepted += 1;
      if (record.status === 'lookup-error') stats.lookupErrors += 1;
      if (record.rosterStatus === 'expected') stats.expected += 1;
      if (record.rosterStatus === 'unexpected') stats.unexpected += 1;
    }
    this.stats = stats;
  }
}
