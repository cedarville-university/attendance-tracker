# Canvas installation

One-time, per-institution setup: register the tool in Canvas, tell the app about Canvas, and verify
an instructor launch.

**Requires a deployed app.** Canvas delivers a launch by form-POSTing a signed `id_token` to a public
HTTPS URL and redirecting the instructor's browser to another one. It cannot reach `localhost`.
Deploy first — see [../infra/azure/README.md](../infra/azure/README.md).

Throughout, `<APP_HOST>` is your deployed hostname with no scheme and no trailing slash, e.g.
`attendance.example.edu`.

## 1. Set the app's own configuration

Before registering, the deployed app needs:

| Variable | Value |
|---|---|
| `APP_BASE_URL` | `https://<APP_HOST>` |
| `ALLOWED_TARGET_LINK_URIS` | `https://<APP_HOST>/index.html` |

`ALLOWED_TARGET_LINK_URIS` is the exact-match allowlist of pages `/lti/launch` may redirect to after
a successful launch. If it does not contain the `target_link_uri` Canvas sends, **every launch
fails** — this is the single most common install error. The app logs a warning at boot if the value
it advertises to Canvas is missing from this list, so check the startup logs.

Also confirm `DATABASE_URL` is set and the schema is migrated. Full variable list:
[operations.md](operations.md).

## 2. Register the tool in Canvas

**Admin → Developer Keys → + Developer Key → + LTI Key.** Set **Method** to **Enter URL** (labels
vary slightly by Canvas version) and enter:

```
https://<APP_HOST>/lti/config.json
```

**Save**, toggle the key **ON**, and copy its **Client ID** (a number like `10000000000001`).

That endpoint generates the registration from the running app's own configuration. Do not hand-write
or paste this JSON: every URL in it must agree with `APP_BASE_URL`, and the LTI Advantage scope
strings must match `server/src/lti/scopes.ts` character-for-character. Generating it removes both
failure modes. To inspect what Canvas will read:

```bash
curl -s https://<APP_HOST>/lti/config.json | jq
```

What it configures, and why:

- **`redirect_uris`** → `/lti/launch`, where Canvas form-POSTs the signed `id_token`.
- **`target_link_uri`** → `/index.html`, *not* `/lti/launch`. Canvas copies this into the launch, and
  `/lti/launch` 303-redirects to it on success; naming the launch endpoint would redirect it to
  itself. This is the value that must appear in `ALLOWED_TARGET_LINK_URIS`.
- **`oidc_initiation_url`** → `/lti/login`.
- **`public_jwk_url`** → `/lti/jwks`. The app publishes its own rotating public keys there, so
  Canvas fetches them by URL rather than caching a static `public_jwk`. Rotating the key then needs
  no Canvas edit, only a re-fetch.
- **`scopes`** → NRPS context-membership read, AGS line items read/write, AGS scores write. The AGS
  Result read scope is deliberately **not** requested.
- **`windowTarget: "_blank"`** on the course-navigation placement. Required: WebHID's Permissions
  Policy defaults to `self`, so a cross-origin Canvas iframe never receives HID capability and the
  card reader cannot be connected at all. This field is why the registration must be JSON — the
  Canvas Apps form has no input for it.
- **`privacy_level: "name_only"`** → NRPS returns names and `lis_person_sourcedid`, but not email.
- **`visibility: "admins"`** → shows the course-nav link to admins and instructors, not learners.
  A UI convenience only; `/lti/launch` validates the role claim independently.

> If your Canvas version's Apps page offers only **Paste JSON**, fetch the endpoint with the `curl`
> command above and paste the output. Re-paste after any upgrade that changes scopes or placements —
> the URL method avoids this.

## 3. Install it in a course

**Course → Settings → Apps → + App → By Client ID.** Paste the Client ID, install, and note the
**Deployment ID** shown afterwards (looks like `1234:abcdef...`).

Installing at the account level instead deploys it to all courses in that account; the Deployment ID
is then found under the account's Apps list.

## 4. Get Canvas's real LTI 1.3 endpoints

**Do not derive these from your institution's Canvas hostname, and do not read them from
`https://<school>.instructure.com/.well-known/openid-configuration`.** That path serves Canvas's
*generic API OAuth2* config — a different protocol — and two of its three values are wrong for
LTI 1.3: its `issuer` is the account subdomain rather than the environment issuer, and its
`authorization_endpoint` is the human API-login flow, not LTI's `/api/lti/authorize_redirect`.

Instructure-hosted Canvas serves LTI 1.3 from **environment-level** endpoints shared by every
account in that environment. Pick the row for the environment you registered in:

| Environment | Issuer (`id_token` `iss`) | OIDC auth endpoint | Token endpoint | Platform JWKS URI |
|---|---|---|---|---|
| Production | `https://canvas.instructure.com` | `https://sso.canvaslms.com/api/lti/authorize_redirect` | `https://sso.canvaslms.com/login/oauth2/token` | `https://sso.canvaslms.com/api/lti/security/jwks` |
| Beta | `https://canvas.beta.instructure.com` | `https://sso.beta.canvaslms.com/api/lti/authorize_redirect` | `https://sso.beta.canvaslms.com/login/oauth2/token` | `https://sso.beta.canvaslms.com/api/lti/security/jwks` |
| Test | `https://canvas.test.instructure.com` | `https://sso.test.canvaslms.com/api/lti/authorize_redirect` | `https://sso.test.canvaslms.com/login/oauth2/token` | `https://sso.test.canvaslms.com/api/lti/security/jwks` |

**Confirm these against Canvas's current LTI configuration documentation — do not trust this table
over Canvas's own.**

The issuer is fixed per environment **regardless of your account subdomain**: a launch from
`yourschool.test.instructure.com` still carries `iss: https://canvas.test.instructure.com`. Using
the account subdomain as the issuer makes every launch fail the `(issuer, client_id)` lookup.

Confirm the JWKS responds before continuing:

```bash
curl -s https://sso.test.canvaslms.com/api/lti/security/jwks | jq '.keys | length'   # expect e.g. 3
```

## 5. Tell the app about Canvas

Open `https://<APP_HOST>/admin.html`. It is deliberately **not linked** from the scanner UI — type
the URL.

**Access** — either:

- launch the tool from Canvas as a user with the **LTI Administrator role**, then open `/admin.html`
  in the same browser; or
- set **`SETUP_TOKEN`** (≥ 16 characters) on the deployed app and paste it into the page's *Setup
  token* field. This bootstraps the first connection before any admin launch is possible. Unset it
  once an admin launch works, which disables the token path.

**Add the connection** using the Client ID from step 2, the Deployment ID from step 3, and the
endpoints from step 4. Upserts are keyed on `issuer + client_id` (endpoints are updated in place) and
on `registration + deployment_id`.

> **Restart caveat.** The Content-Security-Policy `form-action` allowlist is computed once at boot
> from the enabled registrations. After adding a connection for a **new Canvas origin**, restart the
> app before launching from it, or CSP will block the launch. Adding another deployment to an
> already-configured origin needs no restart.

**Tool signing key.** The same page shows the active `kid`, its creation time, and the JWKS URL.
*Rotate key* generates a new keypair and marks the old one `previous` — still published at
`/lti/jwks` so in-flight assertions still verify — effective immediately with no restart. Have Canvas
re-fetch the JWKS afterwards. If `LTI_TOOL_SIGNING_KEYS_JSON` is set it takes precedence; otherwise
the key lives in the `tool_signing_keys` table and survives restarts.

If AGS or NRPS token requests later return 401, Canvas may require the token audience to be the bare
production URL `https://canvas.instructure.com/login/oauth2/token` even from beta or test. Re-save
the connection with that as the token audience.

## 6. Verify

1. From the test course, launch **Attendance** as an instructor. Confirm a **new browser tab**
   opens, the launch completes, the scanner UI loads with the course name and roster count, and an
   `attendance_session` cookie is set.
2. Click **Connect card reader** and confirm the browser shows the HID device chooser. If the app
   reports no WebHID capability, the launch opened in the Canvas iframe — check `windowTarget` on
   the placement.
3. Attempt a **learner-role** launch (a test student account, or Canvas Student View if your
   instance sends learner-role claims). Confirm **HTTP 403** and that no session cookie is set.
4. Start a session, scan or **Mark present** a student, then **Close attendance**. Within a few
   minutes the worker should create an **Attendance** column in the Canvas gradebook. If the panel
   reports a failure, use **Retry grade sync**; check worker logs for AGS errors.

If step 3 does not return 403, capture the real `roles` claim from a launch and compare it against
`AUTHORIZED_INSTRUCTOR_ROLE_URIS` in `server/src/lti/roles.ts`. That set was written from the
standard 1EdTech role vocabulary; this is the checkpoint where it gets confirmed against a real
Canvas payload.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Every launch fails after a clean registration | `ALLOWED_TARGET_LINK_URIS` does not contain `https://<APP_HOST>/index.html`. Check the boot warning in the app logs. |
| Launch fails with a CSP or `form-action` error | A connection was added for a new Canvas origin without restarting the app (step 5). |
| Launch rejected as an unknown registration | The issuer is the account subdomain instead of the environment issuer (step 4). |
| "This browser does not support WebHID" after launch | The tool opened inside the Canvas iframe. Confirm the placement's `windowTarget` is `_blank`. |
| Launch works, roster is empty | The NRPS scope is missing from the Developer Key, or the course has no enrolled students. Re-check the key was created from `/lti/config.json`. |
| AGS/NRPS calls return 401 | Token audience mismatch — see the end of step 5. |
| Grades never appear in Canvas | The worker is not running. In Azure it is a scheduled Container Apps Job; see [operations.md](operations.md). |
