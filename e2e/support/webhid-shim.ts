// A fake `navigator.hid` injected via context.addInitScript before any app code runs, so
// web/hid-reader.js's reconnectKnownDevices() path (navigator.hid.getDevices() -> match on
// vendorId 0x076B -> device.open() -> device.oninputreport = handler) resolves with no hardware
// and no user gesture. `window.__emitCard(bytes)` then delivers ONE synthetic input report.
//
// Byte layout MUST match web/omnikey-parser.js (see its header + web/tests/omnikey-parser.test.js
// buildReport): bytes[0]=version, bytes[1]=declaredLength, bytes[2]=0, payload ASCII from offset 3,
// zero-padded to 40. hid-reader._handleInputReport reads event.reportId + event.data (a DataView),
// and it assigns the handler to the `oninputreport` PROPERTY (not addEventListener), so __emitCard
// invokes that property directly rather than dispatching a DOM event.
//
// HID_VENDOR_ID (web/config.js) = 0x076B; a plausible OMNIKEY productId is used for diagnostics only.

export const HID_VENDOR_ID = 0x076b;
export const OMNIKEY_REPORT_VERSION = 6;
export const OMNIKEY_PAYLOAD_START_OFFSET = 3;
export const OMNIKEY_REPORT_TOTAL_BYTES = 40;

/**
 * Builds the OMNIKEY "Custom Report" byte array web/omnikey-parser.js expects for `cardCode`.
 * Mirrors web/tests/omnikey-parser.test.js's buildReport().
 */
export function buildOmnikeyReportBytes(cardCode: string): number[] {
  const bytes = new Array<number>(OMNIKEY_REPORT_TOTAL_BYTES).fill(0);
  bytes[0] = OMNIKEY_REPORT_VERSION;
  bytes[1] = cardCode.length; // declared length
  bytes[2] = 0;
  for (let i = 0; i < cardCode.length; i += 1) {
    bytes[OMNIKEY_PAYLOAD_START_OFFSET + i] = cardCode.charCodeAt(i);
  }
  return bytes;
}

export const webhidShimScript = `
(() => {
  const HID_VENDOR_ID = ${HID_VENDOR_ID};

  class FakeHidDevice {
    constructor() {
      this.opened = false;
      this.vendorId = HID_VENDOR_ID;
      this.productId = 0x5427;
      this.productName = 'Fake OMNIKEY 5427CK (e2e)';
      this.collections = [];
      this.oninputreport = null;
    }
    async open() { this.opened = true; }
    async close() { this.opened = false; }
    async sendReport() {}
    async sendFeatureReport() {}
    addEventListener() {}
    removeEventListener() {}
  }

  const device = new FakeHidDevice();

  const fakeHid = {
    async requestDevice() { return [device]; },
    async getDevices() { return [device]; },
    addEventListener() {},
    removeEventListener() {},
    onconnect: null,
    ondisconnect: null,
  };

  // navigator.hid is a non-writable accessor on Navigator.prototype in Chromium, so a plain
  // assignment silently no-ops. Shadow it with an own property on the navigator instance.
  try {
    Object.defineProperty(navigator, 'hid', { value: fakeHid, configurable: true });
  } catch (_e) {
    navigator.hid = fakeHid;
  }

  window.__fakeHidDevice = device;

  // Deliver exactly one synthetic inputreport the OMNIKEY parser accepts.
  window.__emitCard = (bytes) => {
    const data = new DataView(Uint8Array.from(bytes).buffer);
    const event = { reportId: 0, data, device };
    if (typeof device.oninputreport === 'function') {
      device.oninputreport(event);
      return true;
    }
    return false;
  };
})();
`;
