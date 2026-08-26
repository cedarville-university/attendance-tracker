# Classroom Attendance Tracker (WebHID)

An attendance tracking tool for university classrooms. A professor connects an HID Global OMNIKEY
5427CK USB card reader, students tap their ID cards, and each scan is resolved to a student
identity by the backend's identity resolver and optionally checked against an uploaded class
roster.

The browser (`web/`) is plain HTML/CSS/JavaScript (ES modules) with no build step or npm
dependency, served by a small Node/TypeScript backend (`server/`, Fastify) that also does all card
lookups -- see §5 below. The only request the browser makes for a scan is a same-origin
`POST /api/scans` to that backend.

## 1. Purpose

- Read a student ID card via a WebHID-connected card reader (not keyboard-wedge keystrokes).
- Resolve the scanned card code to a student identity via the backend's identity resolver.
- Optionally cross-check the result against an uploaded class roster CSV, flagging unexpected
  students prominently (visually and audibly).
- Record each scan locally in the browser and let the professor export the session as CSV.
- Minimize data exposure: no analytics, no telemetry, no third-party libraries in the browser, and
  no card-lookup credentials ever reach the browser -- see §5.

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

The app is now served by a small Fastify backend (`server/src/index.ts`), which serves the
frontend in `web/` as static files and hot-reloads on change:

```bash
npm install
npm run dev
# then open http://localhost:3000/index.html
```

For pure frontend hacking with no backend involved, any static file server pointed at `web/` still
works, since `web/` remains a plain, build-step-free set of ES modules:

```bash
python3 -m http.server 8000 --directory web
# then open http://localhost:8000/index.html
```

Either way, the only requirement is that it's reachable at `http://localhost:<port>` or over HTTPS,
per WebHID's secure-context rule below.

## 5. Configuring the card-lookup identity resolver

Card lookups happen entirely server-side now (`server/src/identity/`), so no lookup credentials or
API URL are ever shipped to the browser. The backend picks a resolver at startup:

- **`MockIdentityResolver`** (the default) fabricates a deterministic pseudo-student per card code,
  so the whole app can be demoed and tested without a real backend API. Two special-case card codes
  exercise error states without hardware: a code containing `NOID` simulates a response missing a
  University ID, and a code containing `ERR` simulates a network failure.
- **`HttpIdentityResolver`** calls a real institutional card-lookup API (ported from this app's
  original browser-side `realLookup()` adapter). It's used automatically once its required
  environment variables are set:

  | Variable | Required | Default |
  | --- | --- | --- |
  | `IDENTITY_API_URL` | yes | -- |
  | `IDENTITY_API_KEY_NAME` | yes | -- |
  | `IDENTITY_API_KEY` | yes | -- |
  | `IDENTITY_API_METHOD` | no | `GET` |
  | `IDENTITY_API_TIMEOUT_MS` | no | `5000` |
  | `IDENTITY_API_UNIVERSITY_ID_FIELD` | no | `redwoodId` |
  | `IDENTITY_API_FIRST_NAME_FIELD` | no | `firstName` |
  | `IDENTITY_API_LAST_NAME_FIELD` | no | `lastName` |
  | `IDENTITY_API_EMAIL_FIELD` | no | `email` |

  `IDENTITY_API_URL` may contain the literal placeholders `{CARD_CODE}`, `{KEY_NAME}`, and `{KEY}`,
  each replaced (URI-encoded) at request time. The `*_FIELD` variables are field names (or
  dot-paths, e.g. `"student.universityId"`) read out of the raw JSON response.
- If neither is explicitly selected, the server falls back to `MockIdentityResolver` -- see
  `docs/canvas-lti/progress.md` for why real ProxID credentials aren't wired up yet.

The `/api/scans` endpoint never logs the raw card code it receives, even in Fastify's request logs.

## 6. Connecting the card reader

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

## 7. Importing a roster

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

## 8. How CSV export works

Click **Download Attendance CSV** to generate and download a CSV of the current session, built
entirely in the browser via a `Blob` and an object URL (no server round-trip for the CSV itself).
The column set is the union of:

- base fields (timestamp, raw card code, University ID, roster status, scan status),
- every field ever returned by the identity resolver across all scans (prefixed `lookup.`), and
- every roster CSV column ever matched across all scans (prefixed `roster.`).

In "Present + Absent" or "Absent only" export mode, roster entries with no matching scan are added
as additional rows, built entirely from the uploaded roster CSV -- no identity lookup is performed
for absent students, so this resolves instantly regardless of roster size.

Values containing commas, quotes, or newlines are quoted and escaped per standard CSV conventions.
The filename is `attendance-YYYY-MM-DD.csv`, using the professor's local date.

## 9. How local persistence works

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

## 10. Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| "This browser does not support WebHID" | Use a recent desktop Chrome or Edge; Firefox/Safari are not supported. |
| "WebHID requires HTTPS or localhost" | Serve the app over HTTPS or from `http://localhost`. |
| Reader doesn't appear in the device chooser | Confirm the OMNIKEY is plugged in and check the reader's vendor ID is `0x076B`; try re-plugging the device. |
| Reader connects but no scans register | Open the **Reader Diagnostics** panel and enable debug mode; tap a card and check whether any raw HID reports appear at all. If reports appear but never parse to a card code, the reader may not be in Custom Report mode -- see section 11. |
| Card scans produce garbled or empty card codes | Enable debug mode in Reader Diagnostics and inspect the hex/ASCII output for a real tap; the four offset constants at the top of `omnikey-parser.js` (`LENGTH_BYTE_OFFSET`, `VERSION_BYTE_OFFSET`, `PAYLOAD_START_OFFSET`, `MIN_REPORT_BYTES`) may need adjusting for your firmware. |
| Every scan shows "Lookup error" | Check the server logs for the resolver's error, and confirm the `IDENTITY_API_*` env vars (see section 5) are correct and the API is reachable from the server. |
| "UNEXPECTED STUDENT" for a student who should be on the roster | Confirm the selected University ID column matches the format the identity resolver returns (e.g. leading zeroes, whitespace) -- both sides are compared as trimmed strings. |
| No sound on an unexpected scan | Confirm the **Sound alerts** toggle is on; some browsers require at least one page click/interaction before audio can play -- click anywhere on the page once after loading. |
| "Remember this session" is greyed out | `localStorage` is unavailable in this browsing context (e.g. private browsing with storage disabled). The app continues to work in-memory. |

Open the **Reader Diagnostics** panel (it doubles as a hardware-test mode) at any time to see
WebHID support status, device details, HID collections/report IDs, raw HID report hex dumps, and an
error log. Use **Copy Diagnostics** to grab a plain-text dump for a bug report.

## 11. OMNIKEY reader configuration

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
web/                          Browser app: plain ES modules, no build step, served statically.
  index.html                   Markup only.
  styles.css                    All styling.
  config.js                     Browser-side tunables: HID vendor ID, duplicate-suppress window, etc.
  omnikey-parser.js              Pure OMNIKEY Custom Report packet parser.
  hid-reader.js                  WebHID transport (connect/reconnect/disconnect, raw report handling).
  roster.js                     Hand-written CSV parser + roster indexing/matching.
  scan-pipeline.js              Scan orchestration: duplicate suppression, record lifecycle, submitScan() correlation.
  absentees.js                   Synchronous roster-diff for "Absent" CSV export rows.
  diagnostics.js                In-memory ring-buffer diagnostic/error log.
  csv.js                        Attendance CSV export (field union + RFC4180 escaping + download).
  storage.js                    Optional localStorage persistence.
  ui.js                         All DOM rendering.
  app.js                        Wiring: DOM events -> the above modules -> ui.js rendering.

server/                       Node/TypeScript backend (Fastify).
  src/index.ts                  App entrypoint: serves web/ statically, health check, resolver selection.
  src/routes/scans.ts           POST /api/scans -- validates the request, calls the identity resolver.
  src/identity/types.ts          IdentityResolver interface + normalized result shape.
  src/identity/mock-resolver.ts  MockIdentityResolver -- deterministic pseudo-student per card code.
  src/identity/http-resolver.ts  HttpIdentityResolver -- real institutional card-lookup API client.
```
