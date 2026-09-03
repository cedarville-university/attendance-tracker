# Classroom Attendance Tracker

A Canvas LTI 1.3 tool for taking classroom attendance with a USB card reader. An instructor launches
it from a Canvas course-navigation link, students tap their ID cards on an HID Global OMNIKEY
reader, and each scan is matched against the Canvas course roster. Attendance posts back to the
Canvas gradebook as a single **Attendance** column.

It appears in Canvas as **Scanttendance** — override that per deployment with `LTI_TOOL_TITLE`.

- The roster comes from Canvas over LTI NRPS. A CSV upload exists only as an offline fallback.
- Grades post to Canvas over LTI AGS from a background worker, with retries and backoff.
- Card lookups happen server-side. No lookup credentials reach the browser.

## Requirements

| | |
|---|---|
| Browser | Desktop **Chrome** or **Edge**. The reader is read via WebHID, which Firefox and Safari do not implement. |
| Serving | **HTTPS**, or `http://localhost` for development. WebHID requires a secure context. |
| Runtime | Node 22, PostgreSQL 16 |
| Hardware | HID Global OMNIKEY 5427CK, configured for Custom Report output — see [docs/card-reader.md](docs/card-reader.md) |

The Canvas course-navigation link must open in a **new tab**, not the Canvas iframe: WebHID's
Permissions Policy defaults to `self`, so an embedded cross-origin frame never receives HID
capability. The generated registration (below) sets this for you.

## 1. Run it locally

```bash
docker compose up -d          # PostgreSQL 16 on :5432
npm install

export DATABASE_URL='postgres://attendance_tracker:attendance_tracker@localhost:5432/attendance_tracker'
export APP_BASE_URL='http://localhost:3000'
export ALLOWED_TARGET_LINK_URIS='http://localhost:3000/index.html'

npm run dev                   # migrates, then serves on http://localhost:3000
```

Those three variables are the only required ones; everything else has a default. There is no `.env`
loading — export them or prefix the command. See [docs/operations.md](docs/operations.md) for the
full variable list.

Without a Canvas connection you can reach `/health/live` and `/lti/config.json`, but the scanner UI
needs a launch session, so it will not render a roster. To exercise the whole launch → scan → grade
flow locally, run the end-to-end suite, which stands up a mock Canvas platform:

```bash
npm test                      # unit + integration (needs docker compose up -d)
npm run test:e2e              # full launch flow against a mock Canvas
```

The grade-sync worker is a **separate one-shot process**: it runs a single pass and exits. Run it
whenever you want queued grades pushed:

```bash
npm run build && npm run worker
```

## 2. Install it in Canvas

This needs a **public HTTPS deployment** — Canvas form-POSTs the launch to your app and cannot reach
`localhost`. Deploy first ([infra/azure/README.md](infra/azure/README.md)), then:

1. **Canvas → Admin → Developer Keys → + Developer Key → + LTI Key.**
   Set **Method** to **Enter URL** and paste:

   ```
   https://<your-app-host>/lti/config.json
   ```

   The app generates the whole registration — endpoints, LTI Advantage scopes, and the
   new-tab course-navigation placement. There is nothing to edit or substitute.
2. **Save**, toggle the key **ON**, and copy its **Client ID**.
3. **Course (or account) → Settings → Apps → + App → By Client ID.** Paste the Client ID, install,
   and note the **Deployment ID**.
4. **Open `https://<your-app-host>/admin.html`** and enter the Canvas issuer, Client ID, Deployment
   ID, and Canvas's OIDC endpoints. This page is not linked from the UI — type the URL.

Canvas's OIDC endpoints are **environment-level values that must not be guessed from your
institution's hostname**, and step 4 has several failure modes worth reading about first.
Full walkthrough and verification checklist: **[docs/canvas-installation.md](docs/canvas-installation.md)**.

## Documentation

| Document | Contents |
|---|---|
| [docs/canvas-installation.md](docs/canvas-installation.md) | Registering in Canvas, Canvas's real LTI 1.3 endpoints, seeding the connection, verifying a launch |
| [docs/operations.md](docs/operations.md) | Environment variables, processes, migrations, the worker, grade sync, health probes, tests |
| [docs/card-reader.md](docs/card-reader.md) | OMNIKEY configuration, connecting, diagnostics, troubleshooting |
| [infra/azure/README.md](infra/azure/README.md) | Azure deployment: Bicep, Container Apps, Key Vault, GitHub OIDC |
| [docs/canvas-lti/spec.md](docs/canvas-lti/spec.md) | Full technical specification (internal reference) |

## What an instructor sees

Launching the Canvas link opens the scanner in a new tab, showing the course, instructor, and
roster count. From there:

- **Start attendance** snapshots the current Canvas roster into a new session.
- Each card tap resolves to a student and marks them present. Off-roster and lookup-failure scans
  are flagged visually and audibly, and are kept separately.
- **Mark present** handles a student without a card; individual scans can be corrected or removed.
- **Close attendance** marks every remaining eligible student absent, recomputes the cumulative
  course grade, and queues the Canvas gradebook update.
- **Past sessions** lists prior sessions and can resume, reopen, delete, or restore them. Deleting
  the last closed session removes the Canvas Attendance column.
- **Download attendance CSV** exports the session.

Grades are cumulative across all closed sessions: present = 1 point, absent = 0, excused excluded
from the denominator, scaled to 100. Reopened and deleted sessions are excluded.

## Project layout

```
web/                    Browser app: plain ES modules, no build step, served statically.
  index.html            Scanner UI markup.
  admin.html            Canvas connection + signing key setup.
  app.js                Wiring: DOM events -> modules -> ui.js.
  ui.js                 All DOM rendering.
  hid-reader.js         WebHID transport (connect/reconnect/disconnect).
  omnikey-parser.js     OMNIKEY Custom Report packet parser.
  scan-pipeline.js      Scan orchestration and duplicate suppression.
  attendance-session.js Server client for the session lifecycle.
  course-roster.js      Server client for the Canvas roster.
  session-history.js    Past-sessions panel.
  roster.js / csv.js    CSV fallback parsing and attendance export.
  storage.js            Optional localStorage persistence.

server/                 Node/TypeScript backend (Fastify).
  src/index.ts          Web entrypoint.
  src/worker.ts         Worker entrypoint: one maintenance + grade-sync pass, then exits.
  src/app.ts            Builds the Fastify instance: security headers, routes, middleware.
  src/lti/              LTI 1.3: login, launch, JWKS, NRPS roster, AGS grades, tool-config.ts.
  src/attendance/       Sessions, scans, grade calculation, sync outbox, line-item deletion.
  src/routes/           HTTP routes.
  src/identity/         Card-code -> student identity resolvers.
  src/database/         Drizzle schema and client.
  migrations/           SQL migrations.

infra/azure/            Bicep templates for Azure Container Apps.
e2e/                    Playwright end-to-end tests against a mock Canvas.
```

## Privacy

No analytics, no third-party browser libraries, and no card-lookup credentials in the browser. The
`/api/attendance-sessions/:id/scans` endpoint never logs raw card codes. Canvas is asked for
`name_only` privacy, so the roster carries names and institutional IDs but not email. Raw card codes
are stored only as an HMAC fingerprint, and only when `CARD_FINGERPRINT_SECRET` is set.

This app makes no specific regulatory compliance claim (e.g. FERPA). Compliance depends on how your
institution deploys and operates it.
