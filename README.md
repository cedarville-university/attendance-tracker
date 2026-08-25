# Classroom Attendance Tracker (WebHID)

A single-page, client-side-only attendance tracking tool for university classrooms. A professor
connects an HID Global OMNIKEY 5427CK USB card reader, students tap their ID cards, and each scan
is resolved to a student identity via an external HTTP API and optionally checked against an
uploaded class roster.

There is no backend, build step, framework, or npm dependency. It is plain HTML/CSS/JavaScript
(ES modules) that runs entirely in the browser tab. The only network request the app ever makes is
the one card-lookup API call per scan, described below.

## 1. Purpose

- Read a student ID card via a WebHID-connected card reader (not keyboard-wedge keystrokes).
- Resolve the scanned card code to a student identity through your institution's card-lookup API.
- Optionally cross-check the result against an uploaded class roster CSV, flagging unexpected
  students prominently (visually and audibly).
- Record each scan locally in the browser and let the professor export the session as CSV.
- Minimize data exposure: no analytics, no telemetry, no third-party libraries, and no roster or
  attendance data is ever sent anywhere except the one lookup request per scan.

This app does not claim any specific regulatory compliance (e.g. FERPA) -- it simply keeps data
local and minimizes what leaves the browser. Compliance is the responsibility of how you deploy
and operate it at your institution.

## 2. Browser requirements

- A **Chromium-based desktop browser**: Google Chrome or Microsoft Edge, recent version, on
  Windows, macOS, or Linux.
- **WebHID is required.** Firefox and Safari do not support the WebHID API and are not supported by
  this app. The app will detect and clearly report an unsupported browser rather than fail silently.

## 3. HTTPS / localhost requirement

WebHID is only available in a [secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts):
either `https://` or `http://localhost` (including `127.0.0.1`). Opening `index.html` directly via
`file://` or serving it over plain HTTP from a non-localhost address will not work, and the app
will show a visible error explaining this.

## 4. Running it locally for testing

No build step is required. From the project directory, serve the files with any static file
server, for example:

```bash
python3 -m http.server 8000
# then open http://localhost:8000/index.html
```

or, with Node installed:

```bash
npx serve .
```

Any static server works -- the only requirement is that it's reachable at `http://localhost:<port>`
or over HTTPS.

## 5. Configuring the external card-lookup API

Most API-specific configuration lives in **`config.js`**, in the `LOOKUP_CONFIG` object:

```js
export const LOOKUP_CONFIG = {
  useMock: false,
  url: 'https://cedarvilledataproxyapi.azurewebsites.net/api/ProxId?id={CARD_CODE}&keyname={KEY_NAME}&key={KEY}',
  method: 'GET',
  headers: () => ({ Accept: 'application/json' }),
  timeoutMs: 5000,
  universityIdField: 'redwoodId',
  firstNameField: 'firstName',
  lastNameField: 'lastName',
  emailField: 'email',
};
```

- `url` may contain the literal placeholders `{CARD_CODE}`, `{KEY_NAME}`, and `{KEY}`, each replaced
  (URI-encoded) at request time: `{CARD_CODE}` with the card code read from the reader, and
  `{KEY_NAME}`/`{KEY}` with whatever is currently saved in the **Card Lookup API Credentials** panel
  (see below).
- `universityIdField` / `firstNameField` / `lastNameField` / `emailField` are field names (or
  dot-paths, e.g. `"student.universityId"`) read out of the raw JSON response. The ProxID API's
  primary student identifier is `redwoodId`, so that's what `universityIdField` points at -- it's
  used as-is everywhere else in the app that talks about a "University ID" (roster matching, record
  identity, CSV export).
- All response-shape-specific logic lives in the `mapRawResponseToNormalized()` function inside
  **`lookup.js`** -- that is the one place to touch if a real API's JSON shape needs custom mapping
  logic beyond a simple field path (e.g. combining two fields, or a lookup table).
- To add another normalized field later (e.g. `cohort`, `dorm`, `gender`): add a matching `*Field`
  entry to `LOOKUP_CONFIG`, then one line inside `mapRawResponseToNormalized()`.
- Setting `useMock` back to `true` switches to a built-in **mock adapter** (clearly marked in
  `lookup.js`) that fabricates a deterministic pseudo-student per card code, so the whole app can be
  demoed and tested without a real backend. Two special-case card codes exercise error states without
  hardware: a code containing `NOID` simulates a response missing a University ID, and a code
  containing `ERR` simulates a network failure.

**Credentials are never hardcoded in `config.js`** -- it ships to every browser that loads the page.
Instead, the API key name and key are entered into the **Card Lookup API Credentials** panel in the
app itself, held in memory and in a dedicated `localStorage` entry managed by **`credentials.js`**
(see §10). If either is unset, every lookup fails fast as a `missing-credentials` lookup error
without making a network request. If a different real API requires authentication that isn't safe to
expose client-side at all, the API itself needs to be scoped so that only expected campus
networks/devices can reach it.

## 6. CORS requirement

Because this is a pure browser-side client with no backend proxy, **the external card-lookup API's
server must send an `Access-Control-Allow-Origin` header permitting this app's origin** (e.g.
`https://attendance.example.edu`, or `http://localhost:8000` during development). Without correct
CORS headers, the browser will block the response and every scan will show a lookup error.

## 7. Connecting the card reader

1. Click **Connect Card Reader**. This opens the browser's HID device chooser (this must be a
   direct response to the click -- WebHID requires a user gesture).
2. Select the OMNIKEY reader from the list and approve access.
3. The **Reader Status** panel updates to "Connected" and shows the device's product name.
4. On future visits, the app automatically attempts to reconnect to a previously-authorized reader
   on page load (no chooser dialog, no user gesture needed) via `navigator.hid.getDevices()`. The
   app never stores the device object itself -- only the browser's own WebHID permission grant
   persists this.
5. Click **Disconnect** to close the connection. If the reader is physically unplugged mid-session,
   the app detects this and updates the status automatically.

If the browser denies permission, no compatible device is found, or `device.open()` fails (e.g. the
reader is in use by another application), a clear message is shown and the app remains usable.

## 8. Importing a roster

1. In the **Expected Students / Class Roster** panel, click **Load CSV…** and choose a roster file.
   The first row is treated as column headers.
2. Once loaded, the filename and row count are shown, and the **University ID column** dropdown is
   populated from the CSV's header row. Select the column that contains each student's University ID.
3. Check **Enable roster checking** to turn on matching. (This is blocked with an error message
   until a University ID column has been selected.)
4. Click **Clear Roster** to remove the loaded roster and turn roster checking back off.

The CSV parser is hand-written and handles commas inside quoted fields, escaped double quotes
(`""`), both CRLF and LF line endings, blank lines, UTF-8, and a leading UTF-8 BOM. University IDs
are always compared as trimmed strings -- never converted to numbers -- so leading zeroes are
preserved. **No roster data is ever uploaded anywhere**; the CSV is parsed entirely in the browser.

When a scanned card's University ID matches a roster row, the *entire* matched CSV row is retained
with that scan record, so the CSV export can include extra roster columns (section, classification,
etc.) without the app needing to know their names in advance.

## 9. How CSV export works

Click **Download Attendance CSV** to generate and download a CSV of the current session, built
entirely in the browser via a `Blob` and an object URL (no server round-trip). The column set is
the union of:

- base fields (timestamp, raw card code, University ID, roster status, scan status),
- every field ever returned by the lookup API across all scans (prefixed `lookup.`), and
- every roster CSV column ever matched across all scans (prefixed `roster.`).

Values containing commas, quotes, or newlines are quoted and escaped per standard CSV conventions.
The filename is `attendance-YYYY-MM-DD.csv`, using the professor's local date.

## 10. How local persistence works

By default, the app keeps everything **in memory only** -- closing the tab loses the session.

Turning on **Remember this session on this computer** saves the current attendance records,
suppressed-duplicate count, loaded roster (including the selected ID column), and sound-alert
preference to `localStorage`, debounced shortly after each change. On a later visit, if saved data
is found, a banner offers to **Restore Session** or **Discard** -- restoring is never automatic.

**Clear Local Data** removes the saved data from `localStorage` (it does not affect whatever is
currently in memory -- use **Clear Roster** / **Clear All** for that).

WebHID device permissions are never included in this saved data; the browser's own WebHID
permission store is used for reconnecting to previously-authorized readers instead.

If `localStorage` is unavailable (e.g. a strict private-browsing mode), the app detects this,
disables the "Remember this session" toggle, shows a notice, and continues working normally
in-memory-only.

**Card Lookup API Credentials** (key name + key) are saved separately, under their own
`localStorage` entry managed by `credentials.js`, independent of the "Remember this session" toggle
above -- they're operational configuration rather than student data, so they persist across visits
even if a professor never turns "Remember this session" on. Use **Clear Saved Key** in that panel to
remove them.

## 11. Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| "This browser does not support WebHID" | Use a recent desktop Chrome or Edge; Firefox/Safari are not supported. |
| "WebHID requires HTTPS or localhost" | Serve the app over HTTPS or from `http://localhost`. |
| Reader doesn't appear in the device chooser | Confirm the OMNIKEY is plugged in and check the reader's vendor ID is `0x076B`; try re-plugging the device. |
| Reader connects but no scans register | Open the **Reader Diagnostics** panel and enable debug mode; tap a card and check whether any raw HID reports appear at all. If reports appear but never parse to a card code, the reader may not be in Custom Report mode -- see section 12. |
| Card scans produce garbled or empty card codes | Enable debug mode in Reader Diagnostics and inspect the hex/ASCII output for a real tap; the four offset constants at the top of `omnikey-parser.js` (`LENGTH_BYTE_OFFSET`, `VERSION_BYTE_OFFSET`, `PAYLOAD_START_OFFSET`, `MIN_REPORT_BYTES`) may need adjusting for your firmware. |
| Every scan shows "Lookup error" | Check `config.js`'s `LOOKUP_CONFIG.url`/fields, confirm the API is reachable, and confirm the API's CORS headers permit this app's origin (see section 6). |
| "UNEXPECTED STUDENT" for a student who should be on the roster | Confirm the selected University ID column matches the format the lookup API returns (e.g. leading zeroes, whitespace) -- both sides are compared as trimmed strings. |
| No sound on an unexpected scan | Confirm the **Sound alerts** toggle is on; some browsers require at least one page click/interaction before audio can play -- click anywhere on the page once after loading. |
| "Remember this session" is greyed out | `localStorage` is unavailable in this browsing context (e.g. private browsing with storage disabled). The app continues to work in-memory. |

Open the **Reader Diagnostics** panel (it doubles as a hardware-test mode) at any time to see
WebHID support status, device details, HID collections/report IDs, raw HID report hex dumps, and an
error log. Use **Copy Diagnostics** to grab a plain-text dump for a bug report.

## 12. OMNIKEY reader configuration

This app expects the reader to be configured for:

```
Keyboard Wedge Enable: ON
Output Type: Custom Report
```

This is **deliberately different** from the reader's ordinary keyboard-wedge behavior, where a
scanned card is typed out as keystrokes into whatever text field has focus. In Custom Report mode,
the reader instead sends structured HID input reports that this app reads directly via the WebHID
API, independent of page focus -- so card scans work correctly no matter what element on the page is
focused.

Recommended reader configuration for use with this app:

- **Output Type: Custom Report** (not "Keyboard Emulation").
- Disable unnecessary **Card In**, **Card Out**, **prestroke**, and **poststroke** output strings,
  and configure the reader to output only the card identifier itself. The app can tolerate extra
  reports per tap (it ignores structurally valid reports with no decoded payload), but a
  minimal, single-report-per-tap configuration is simpler to verify and debug.
- Vendor ID `0x076B` (HID Global) is used to filter the device chooser; no specific product ID is
  assumed, so other HID Global readers speaking the same Custom Report protocol should also work.

Because the exact byte layout of a Custom Report packet can vary by reader generation/firmware, the
parsing logic lives entirely in `omnikey-parser.js`, is documented inline, and exposes its
assumptions as small named constants at the top of the file so they can be adjusted after testing
against real hardware (using the Reader Diagnostics debug view to inspect actual raw reports).

## Project structure

```
index.html          Markup only.
styles.css           All styling.
config.js            Central configuration: HID vendor ID, lookup API settings, tunables.
omnikey-parser.js     Pure OMNIKEY Custom Report packet parser.
hid-reader.js         WebHID transport (connect/reconnect/disconnect, raw report handling).
lookup.js            Card lookup adapter (mock + real fetch), normalizes API responses.
credentials.js        Card lookup API key name/key: in-memory + localStorage persistence.
roster.js            Hand-written CSV parser + roster indexing/matching.
scan-pipeline.js     Scan orchestration: duplicate suppression, record lifecycle, lookup correlation.
diagnostics.js       In-memory ring-buffer diagnostic/error log.
csv.js               Attendance CSV export (field union + RFC4180 escaping + download).
storage.js           Optional localStorage persistence.
ui.js                All DOM rendering.
app.js               Wiring: DOM events -> the above modules -> ui.js rendering.
```
