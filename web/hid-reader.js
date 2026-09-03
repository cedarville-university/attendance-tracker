// hid-reader.js
//
// Owns all interaction with the browser's WebHID API (navigator.hid). This
// module is a "dumb" transport layer: it knows how to find, open, read
// from, and close an HID Global (vendor ID 0x076B) card reader, and it
// hands parsed reports up via callbacks. It never touches the DOM directly
// -- all UI updates happen in ui.js, driven by app.js.
//
// WebHID device *permission grants* are never persisted by this app. On
// each page load, reconnectKnownDevices() uses navigator.hid.getDevices()
// to find devices the user has already authorized in a previous session,
// per the WebHID spec's own persistence model -- we do not attempt to
// store or serialize HIDDevice objects ourselves.

import { HID_VENDOR_ID } from './config.js';
import { logEvent } from './diagnostics.js';
import { parseOmnikeyReport } from './omnikey-parser.js';

/**
 * @returns {boolean} Whether this browser exposes navigator.hid at all.
 */
export function isWebHidSupported() {
  return typeof navigator !== 'undefined' && 'hid' in navigator;
}

/**
 * @returns {boolean} Whether the page is running in a secure context
 * (HTTPS or localhost), a hard requirement for WebHID.
 */
export function isSecureContext() {
  return typeof window !== 'undefined' && window.isSecureContext === true;
}

/**
 * Summarizes an HIDDevice's collections for diagnostics display: top-level
 * usage page/usage plus the report IDs declared for each collection's
 * input reports.
 * @param {HIDDevice} device
 */
function summarizeCollections(device) {
  return (device.collections || []).map((collection) => ({
    usagePage: collection.usagePage,
    usage: collection.usage,
    inputReportIds: (collection.inputReports || []).map((report) => report.reportId),
  }));
}

/**
 * Builds a plain-object summary of a device suitable for diagnostics
 * display and logging (never persisted to storage).
 * @param {HIDDevice|null} device
 */
export function describeDevice(device) {
  if (!device) return null;
  return {
    productName: device.productName,
    vendorId: device.vendorId,
    vendorIdHex: `0x${device.vendorId.toString(16).padStart(4, '0')}`,
    productId: device.productId,
    productIdHex: `0x${device.productId.toString(16).padStart(4, '0')}`,
    opened: device.opened,
    collections: summarizeCollections(device),
  };
}

export class HidReader {
  /**
   * @param {Object} callbacks
   * @param {(report: {reportId: number, data: DataView, parsed: import('./omnikey-parser.js').OmnikeyParseResult}) => void} callbacks.onReport
   * @param {(state: {connected: boolean, device: object|null, reason?: string}) => void} callbacks.onConnectionChange
   * @param {(error: Error, kind: string) => void} callbacks.onError
   */
  constructor({ onReport, onConnectionChange, onError } = {}) {
    this.onReport = onReport || (() => {});
    this.onConnectionChange = onConnectionChange || (() => {});
    this.onError = onError || (() => {});
    /** @type {HIDDevice|null} */
    this.device = null;

    this._handleInputReport = this._handleInputReport.bind(this);
    this._handleBrowserConnect = this._handleBrowserConnect.bind(this);
    this._handleBrowserDisconnect = this._handleBrowserDisconnect.bind(this);

    if (isWebHidSupported()) {
      navigator.hid.addEventListener('connect', this._handleBrowserConnect);
      navigator.hid.addEventListener('disconnect', this._handleBrowserDisconnect);
    }
  }

  /**
   * Invokes the browser's HID device chooser, filtered to HID Global's
   * vendor ID. Must be called from within a user-gesture handler (e.g. a
   * button click), per the WebHID spec.
   */
  async connect() {
    if (!isWebHidSupported()) {
      const err = new Error('This browser does not support WebHID. Use a recent Chrome or Edge on desktop.');
      logEvent('error', { kind: 'webhid-unavailable', message: err.message });
      this.onError(err, 'webhid-unavailable');
      throw err;
    }
    if (!isSecureContext()) {
      const err = new Error('WebHID requires HTTPS or localhost. This page was not loaded from a secure context.');
      logEvent('error', { kind: 'insecure-origin', message: err.message });
      this.onError(err, 'insecure-origin');
      throw err;
    }

    let devices;
    try {
      devices = await navigator.hid.requestDevice({ filters: [{ vendorId: HID_VENDOR_ID }] });
    } catch (err) {
      logEvent('error', { kind: 'hid-permission-denied', message: err.message });
      this.onError(err, 'permission-denied');
      throw err;
    }

    if (!devices || devices.length === 0) {
      const err = new Error('No compatible reader was selected.');
      logEvent('error', { kind: 'no-device-selected', message: err.message });
      this.onError(err, 'no-device-selected');
      throw err;
    }

    await this._openDevice(devices[0]);
  }

  /**
   * Attempts to silently reconnect to a reader the user has previously
   * authorized, without showing the device chooser. Safe to call on page
   * load. Returns true if a device was found and opened.
   * @returns {Promise<boolean>}
   */
  async reconnectKnownDevices() {
    if (!isWebHidSupported()) return false;

    let devices;
    try {
      devices = await navigator.hid.getDevices();
    } catch (err) {
      logEvent('error', { kind: 'reconnect-failed', message: err.message });
      return false;
    }

    const match = devices.find((device) => device.vendorId === HID_VENDOR_ID);
    if (!match) return false;

    try {
      await this._openDevice(match);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Closes the currently open device, if any.
   */
  async disconnect() {
    if (!this.device) return;
    const info = describeDevice(this.device);
    try {
      this.device.oninputreport = null;
      await this.device.close();
    } catch (err) {
      logEvent('error', { kind: 'device-close-failed', message: err.message });
      this.onError(err, 'close-failed');
    }
    logEvent('device-disconnected', { ...info, note: 'closed by user' });
    this.device = null;
    this.onConnectionChange({ connected: false, device: null });
  }

  /** @returns {object|null} A diagnostics-friendly description of the current device, or null. */
  getDeviceInfo() {
    return describeDevice(this.device);
  }

  /** @private */
  async _openDevice(device) {
    try {
      if (!device.opened) {
        await device.open();
      }
    } catch (err) {
      logEvent('error', { kind: 'device-open-failed', message: err.message });
      this.onError(err, 'open-failed');
      throw err;
    }

    this.device = device;
    device.oninputreport = this._handleInputReport;

    const info = describeDevice(device);
    logEvent('device-connected', info);
    this.onConnectionChange({ connected: true, device: info });
  }

  /** @private */
  _handleInputReport(event) {
    const { reportId, data } = event;
    const parsed = parseOmnikeyReport(reportId, data);
    this.onReport({ reportId, data, parsed });
  }

  /** @private Browser-level event: a previously-authorized device became available (e.g. plugged in). */
  _handleBrowserConnect(event) {
    logEvent('device-connected', {
      productName: event.device.productName,
      note: 'HID connect event (device became available; not yet opened)',
    });
  }

  /** @private Browser-level event: a device was unplugged or became unavailable. */
  _handleBrowserDisconnect(event) {
    if (this.device && event.device === this.device) {
      const info = describeDevice(this.device);
      logEvent('device-disconnected', { ...info, note: 'reader disconnected mid-session' });
      this.device = null;
      this.onConnectionChange({ connected: false, device: null, reason: 'disconnected' });
    }
  }
}
