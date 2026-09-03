# Canvas install JSON endpoint + user-facing docs rewrite

Date: 2026-09-02

## Problem

Two problems, one root cause: the Canvas registration JSON lives in prose.

1. **The documented JSON is wrong.** `docs/canvas-installation.md:28` instructs the operator to
   replace `<APP_BASE_URL>` with an origin *including the scheme* ("e.g. `https://attendance.example.edu`"),
   but the template then wraps it again — `"https://<APP_BASE_URL>/lti/login"`. Substituting as
   instructed produces `https://https://attendance.example.edu/lti/login`. Five fields are affected.
   Separately, `"domain": "<APP_BASE_URL>"` wants a bare hostname, not an origin. `APP_BASE_URL` is
   normalized to a scheme-bearing origin in `server/src/config/env.ts:10-13`, so the env var and the
   doc placeholder genuinely disagree and no substitution satisfies both.
2. **The scope strings are duplicated by hand.** `server/src/lti/scopes.ts:13` instructs future
   editors to keep the doc copy character-identical, which is an obligation no test enforces.

Hand-substituted JSON in a Markdown file cannot be verified. The fix is to make the app emit it.

## Approach

Serve the config from the app and install it in Canvas **by URL**. Canvas's LTI Key creation accepts
a config URL, so the operator never edits or pastes JSON, and the registration is regenerated from
live code on every Canvas refresh.

Rejected alternatives:

- **CLI generator** (`npm run lti:config -- --base-url=...`): fixes drift but keeps the operator
  pasting a blob, and re-pasting whenever scopes or placements change.
- **Fix the placeholders only**: cheapest, but leaves both the substitution risk and the
  hand-synced scope strings in place.

## Components

### `server/src/lti/tool-config.ts` (new)

A pure builder, no Fastify and no DB, so it is unit-testable in isolation.

- `buildCanvasToolConfig(appBaseUrl): CanvasToolConfig` — the whole registration body.
- `toolTargetLinkUri(appBaseUrl): string` — exported separately because `app.ts` needs it for the
  boot check below.
- Every URL is built with `new URL(path, appBaseUrl)`, never string concatenation. This makes the
  double-scheme bug class structurally impossible rather than merely fixed.
- `extensions[0].domain` is `new URL(appBaseUrl).host` — a bare hostname, per Canvas.
- `scopes` imports the three constants from `server/src/lti/scopes.ts`, retiring that file's
  hand-sync instruction to the docs.
- `title` / `description` are module constants, not env vars (YAGNI; a one-line change if an
  institution ever needs to rename the tool).
- The non-obvious field choices keep their reasoning as code comments, where they are next to the
  values they explain: `windowTarget: "_blank"` (WebHID's Permissions Policy defaults to `self`, so
  the scanner must open top-level — spec §8), `privacy_level: "name_only"` (spec §10.2),
  `visibility: "admins"` (UI convenience only; the backend validates the role claim independently —
  spec §10.1), and `target_link_uri` → `/index.html` rather than `/lti/launch` (which would redirect
  the launch endpoint to itself).

### `server/src/routes/lti-config.ts` (new)

`GET /lti/config.json`, registered in `app.ts` next to `registerLtiJwksRoute`.

Public and unauthenticated — Canvas fetches it server-side during registration, so it cannot carry a
session. It exposes nothing sensitive: public URLs, standardized scope URIs, and placement settings.
It touches no database and does no I/O, making it as cheap as `/health/live`, so it stays outside the
30 req/min rate-limit scope that wraps `/lti/login` and `/lti/launch`.

### Boot-time misconfiguration check (`server/src/app.ts`)

The one failure the endpoint cannot prevent on its own: `target_link_uri` must also appear in
`ALLOWED_TARGET_LINK_URIS`, or a correctly-registered tool 403s on every launch. Both values are
known at boot, so `buildApp` logs one `warn` when the emitted `target_link_uri` is absent from
`parseAllowedTargetLinkUris(env)`.

A warning, not a startup failure: deliberately pointing the placement at a different allowlisted
page is legal, so this must not be fatal.

## Testing

`server/tests/lti/tool-config.test.ts` — builder unit tests:

- All five URLs have exactly one scheme and derive from the passed origin. Includes a port-bearing
  origin (`http://localhost:3000`) to prove the URL construction holds.
- `scopes` deep-equals the three imported `scopes.ts` constants — this is the regression guard
  against a future paraphrase.
- `domain` contains no scheme and no slash.
- `windowTarget` is `_blank` and `target_link_uri` points at `/index.html`, not `/lti/launch`.

`server/tests/routes/lti-config.test.ts` — route test via `app.inject`: 200, JSON content type, and
a body matching the builder. Follows the dependency-free pattern of
`server/tests/routes/lti-jwks.test.ts`.

## Documentation

| File | Status | Contents |
|---|---|---|
| `README.md` | rewritten, lean | What it is, browser/HTTPS requirements, local-dev quickstart, Canvas install in four steps, docs index |
| `docs/canvas-installation.md` | rewritten | Register by URL, install in course, seed the connection via `/admin.html`, verify. The static JSON block is deleted; Canvas's environment-level endpoint table stays, as that is real institutional knowledge that cannot be derived. |
| `docs/operations.md` | new | Full env-var table, migrations (dev vs prod), the worker, grade-sync retry constants, health probes, tests. Links to `infra/azure/README.md` rather than duplicating the Azure runbook. |
| `docs/card-reader.md` | new | OMNIKEY Custom Report configuration, the parser constants, diagnostics, troubleshooting |

The README currently mixes deep internals (CSV escaping, localStorage semantics, OMNIKEY byte
offsets) into the setup path and its project tree predates the `web/` + `server/` split. Nothing
useful is deleted — it moves to the topic files above so the setup path is unobstructed.

Two incidental factual fixes: the stale `docker-compose.yml:1-2` header comment (claims Postgres is
"unused until Phase 5" and "No application code reads this database yet") and the README project
tree.

## Out of scope

Documented as current behavior, not changed:

- The identity resolver falls back to `MockIdentityResolver` silently when any of the three required
  `IDENTITY_API_*` vars is missing (`server/src/identity/http-resolver.ts:131-148` returns `null`;
  `server/src/index.ts:35` falls back with no warning).
- `RETENTION_DAYS` is unset in every Bicep param file, so the audit-event retention sweep is inert
  in Azure today.
