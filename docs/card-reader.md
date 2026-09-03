# Card reader

Configuring and troubleshooting the HID Global OMNIKEY 5427CK.

## Required reader configuration

```
Keyboard Wedge Enable: ON
Output Type: Custom Report
```

This is **deliberately not** ordinary keyboard-wedge behavior, where a scanned card is typed as
keystrokes into whatever field has focus. In Custom Report mode the reader sends structured HID
input reports that the app reads directly via WebHID, independent of page focus — so scans work no
matter which element on the page is focused.

Also recommended:

- Disable unnecessary **Card In**, **Card Out**, **prestroke**, and **poststroke** output strings;
  configure the reader to emit only the card identifier. The app tolerates extra reports per tap
  (it ignores structurally valid reports with no decoded payload), but one report per tap is simpler
  to verify.
- Vendor ID `0x076B` (HID Global) filters the device chooser. No product ID is assumed, so other HID
  Global readers speaking the same Custom Report protocol should also work.

## Browser requirements

- **Desktop Chrome or Edge.** WebHID is not implemented in Firefox or Safari; the app detects and
  reports this rather than failing silently.
- **HTTPS or `http://localhost`.** WebHID requires a
  [secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts).
- **The page must be top-level, not framed.** WebHID's Permissions Policy defaults to `self`, so a
  cross-origin Canvas iframe never receives HID capability. The Canvas placement opens the scanner
  in a new tab for exactly this reason.

## Connecting

1. Click **Connect card reader**. This opens the browser's HID device chooser, which must be a
   direct response to the click — WebHID requires a user gesture.
2. Select the OMNIKEY and approve access.
3. The reader status shows **Connected** with the device's product name.
4. On later visits the app reconnects automatically to a previously authorized reader on page load,
   with no chooser and no gesture, via `navigator.hid.getDevices()`. The app never stores the device
   itself — only the browser's own WebHID permission grant persists.
5. **Disconnect** closes the connection. Unplugging the reader mid-session is detected and the
   status updates automatically.

If permission is denied, no compatible device is found, or `device.open()` fails (e.g. another
application holds the reader), a clear message is shown and the app stays usable.

## Diagnostics

Open the **Reader diagnostics** panel at any time. It doubles as a hardware test mode and shows
WebHID support, secure-context status, device details, HID collections and report IDs, raw HID report
hex dumps (with **Debug mode** on), and an error log. **Copy diagnostics** produces a plain-text dump
for a bug report.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| "This browser does not support WebHID" | Use recent desktop Chrome or Edge. If the browser is correct, the page is probably framed — the Canvas link must open in a new tab. |
| "WebHID requires HTTPS or localhost" | Serve over HTTPS or from `http://localhost`. |
| Reader missing from the device chooser | Confirm it is plugged in and its vendor ID is `0x076B`; try re-plugging. |
| Connects, but no scans register | Enable debug mode in Reader diagnostics and tap a card. If no raw reports appear at all, it is a connection or firmware issue. If reports appear but never decode, the reader is probably not in Custom Report mode. |
| Garbled or empty card codes | Inspect the hex/ASCII dump for a real tap. The four constants at the top of `web/omnikey-parser.js` — `LENGTH_BYTE_OFFSET`, `VERSION_BYTE_OFFSET`, `PAYLOAD_START_OFFSET`, `MIN_REPORT_BYTES` — may need adjusting for your firmware. |
| Every scan shows a lookup error | Check server logs for the resolver's error and confirm the `IDENTITY_API_*` variables are correct and the API is reachable from the server. Note the silent mock fallback described in [operations.md](operations.md). |
| A rostered student reads as not on the roster | The institutional ID from the card lookup does not match what Canvas returns. Both sides are compared as trimmed strings, so check for leading zeroes or whitespace. |
| No sound on an unexpected scan | Confirm **Sound alerts** is on. Some browsers require one page interaction before audio can play — click anywhere once after loading. |
| "Remember this session" is greyed out | `localStorage` is unavailable in this context (e.g. private browsing with storage disabled). The app continues in memory. |

## Parser notes

The exact byte layout of a Custom Report packet varies by reader generation and firmware, so all
parsing lives in `web/omnikey-parser.js`, is documented inline, and exposes its assumptions as named
constants at the top of the file. Adjust them against real hardware using the diagnostics debug view.

## CSV roster fallback

The **Roster CSV fallback** panel is an offline aid only — it never feeds Canvas or grade sync. The
CSV is parsed entirely in the browser and is never transmitted anywhere. The parser handles commas
inside quoted fields, escaped double quotes, CRLF and LF endings, blank lines, UTF-8, and a leading
BOM. IDs are compared as trimmed strings and never converted to numbers, so leading zeroes survive.

**Enable roster checking** stays disabled until a CSV is loaded and a University ID column is
selected. When a scan matches a roster row, the entire matched row is retained with the scan record,
so a CSV export can carry extra roster columns (section, classification, and so on) without the app
knowing their names in advance.
