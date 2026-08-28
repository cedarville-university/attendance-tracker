# Canvas registration and real-launch verification (Phase 7, post-deployment)

This is the one-time, per-institution setup that registers this tool in Canvas and the checklist for
verifying an instructor launch works end-to-end against a **real** Canvas instance.

**This step cannot run until the app is deployed.** Canvas delivers an LTI launch by form-POSTing a
signed `id_token` to a public HTTPS URL and by redirecting the instructor's browser to another one;
it cannot reach `http://localhost`. So everything below requires a publicly reachable HTTPS
deployment of this application — i.e. **Phase 7** (spec §54 "Implementation phases": Dockerfile,
Bicep, Azure Container Apps, DNS/TLS) must be done first. Until then, `<APP_BASE_URL>` in the steps
below has no value to fill in.

Phase 3's exit criterion is met entirely by the automated suite: `npm test` runs all 24 cases in
spec §45 against an in-process mock Canvas platform. The steps here are the separate, real-Canvas
confirmation, and they are the only place `server/src/lti/roles.ts`'s `AUTHORIZED_INSTRUCTOR_ROLE_URIS`
set gets checked against an actual Canvas launch payload (step 5).

## 1. Register the tool in Canvas (Admin → Apps)

Register from the account-level **Admin → Apps** page (the LTI registration UI). Canvas's current
Apps form collects the redirect URI, target link URI, OIDC initiation URL, and JWK/JWKS, but it does
**not** expose the LTI Advantage (NRPS/AGS) scope toggles, and it has **no** placement
"window target" / "open in new tab" field. Both of those are required here, and both can only be set
through the **JSON configuration** method. So configure the whole tool as JSON.

In **Admin → Apps**, add the app and choose the **paste-JSON / manual JSON configuration** option
(exact label varies by Canvas version), then paste the block below with `<APP_BASE_URL>` replaced by
your deployed origin (e.g. `https://attendance.example.edu`, no trailing slash):

```json
{
  "title": "Attendance",
  "description": "Classroom attendance via a browser-connected HID card reader",
  "oidc_initiation_url": "https://<APP_BASE_URL>/lti/login",
  "target_link_uri": "https://<APP_BASE_URL>/index.html",
  "public_jwk_url": "https://<APP_BASE_URL>/lti/jwks",
  "redirect_uris": ["https://<APP_BASE_URL>/lti/launch"],
  "scopes": [
    "https://purl.imsglobal.org/spec/lti-nrps/scope/contextmembership.readonly",
    "https://purl.imsglobal.org/spec/lti-ags/scope/lineitem",
    "https://purl.imsglobal.org/spec/lti-ags/scope/score"
  ],
  "extensions": [
    {
      "platform": "canvas.instructure.com",
      "domain": "<APP_BASE_URL>",
      "privacy_level": "name_only",
      "settings": {
        "text": "Attendance",
        "placements": [
          {
            "placement": "course_navigation",
            "message_type": "LtiResourceLinkRequest",
            "target_link_uri": "https://<APP_BASE_URL>/index.html",
            "text": "Attendance",
            "windowTarget": "_blank",
            "default": "enabled",
            "visibility": "admins"
          }
        ]
      }
    }
  ]
}
```

Field notes:

- **`redirect_uris` → `https://<APP_BASE_URL>/lti/launch`**: where Canvas form-POSTs the signed
  `id_token`. If you use the Apps form for this field instead of the JSON, its value must still be
  exactly this.
- **`target_link_uri` → `https://<APP_BASE_URL>/index.html`, not `/lti/launch`.** Canvas copies this
  into the launch's `target_link_uri`, and `/lti/launch` issues a 303 redirect to it after a
  successful launch. Pointing it at `/lti/launch` would redirect the launch endpoint back to itself.
  Whatever you put here must also appear verbatim in the app's `ALLOWED_TARGET_LINK_URIS` env var
  (step 5.1), which is the exact-match allowlist that makes that redirect safe.
- **`oidc_initiation_url` → `https://<APP_BASE_URL>/lti/login`.**
- **`public_jwk_url` → `https://<APP_BASE_URL>/lti/jwks`** (this app publishes its own public keys
  there; do not paste a static `public_jwk`).
- **`scopes`**: spec §10 requires NRPS context-membership read-only, AGS line items read/write, and
  AGS scores write — and nothing else (no AGS Result read scope). This app does not call NRPS or AGS
  until Phases 4 and 6, but the same registration is reused through those phases, so grant the scopes
  now. **Confirm these three scope strings against Canvas's current LTI configuration reference
  (spec §58) — do not trust this file's copy over Canvas's own documentation.**
- **`windowTarget: "_blank"`** on the `course_navigation` placement is required: WebHID's
  Permissions Policy defaults to `self`, so a cross-origin Canvas iframe does not receive WebHID
  capability and the scanner must open top-level (spec §8). This key is JSON-only — it is the main
  reason the whole config goes in as JSON rather than the form.
- **`visibility: "admins"`** — in a course placement this shows the link to admins and instructors,
  not learners. It is a UI convenience only; the backend still validates the LTI role claim
  independently (spec §10.1).
- **`privacy_level: "name_only"`** — NRPS then returns `lis_person_sourcedid` and names but not
  email (spec §10.2).

Save, toggle the resulting key/app **On**, and copy its **Client ID**.

## 2. Install it in your test course

In the Canvas test course: **Settings → Apps → + App → By Client ID**, paste the Client ID, install
it, and note the generated **Deployment ID** (shown after installation).

## 3. Fetch Canvas's real endpoints

**Never derive these from the Canvas hostname by pattern-matching a URL** — the spec explicitly
forbids this (spec §11), because Canvas's actual issuer/JWKS/token endpoints do not follow a fixed
pattern across all Canvas instances. Fetch them for real:

```bash
curl -s https://<canvas-domain>/.well-known/openid-configuration | jq '{issuer, authorization_endpoint, token_endpoint}'
curl -s https://<canvas-domain>/api/lti/security/jwks | jq '.keys | length'   # just to confirm it responds
```

Use the `authorization_endpoint` value as `--oidc-auth-endpoint`, `token_endpoint` as
`--token-endpoint`, and `https://<canvas-domain>/api/lti/security/jwks` as `--platform-jwks-uri`.

## 4. Seed the registration

Run `server/src/database/seed-registration.ts` (see its usage comment) with the issuer, client ID,
endpoints, and deployment ID gathered above, against the `DATABASE_URL` of the deployed app
instance.

## 5. Verify the launch

1. Set the deployed app's `ALLOWED_TARGET_LINK_URIS` to include the exact **target link URI** you
   configured in step 1 — `https://<APP_BASE_URL>/index.html` — since that is the page `/lti/launch`
   redirects to on success. (The list may hold several entries, e.g. `/index.html,/scanner.html`; a
   launch is redirected to whichever one Canvas sent, not to the first.) Also set
   `LTI_TOOL_SIGNING_KEYS_JSON` for any non-throwaway instance (otherwise a restart rotates the
   signing key and Canvas's cached JWKS fetch may briefly go stale).
2. From the test course, launch **Attendance** as an instructor.
3. Confirm: a new browser tab opens (per spec §8's window-target requirement), the launch completes
   without error, the browser lands on the scanner UI, and a session cookie (`attendance_session`)
   is set.
4. Attempt or simulate a learner-role launch of the same tool (e.g. a test student account, or a
   Canvas "Student View" launch if your Canvas instance's Student View sends learner-role claims).
   Confirm it returns **HTTP 403** and does **not** set a session cookie.
5. If step 4 fails in a way that suggests Canvas's real role-claim URIs differ from
   `server/src/lti/roles.ts`'s `AUTHORIZED_INSTRUCTOR_ROLE_URIS` set, capture the actual `roles`
   claim from a real launch (e.g. via a temporary debug log statement, removed before committing)
   and update that set to match — this set was written from the standard 1EdTech role vocabulary but
   has not yet been verified against a real Canvas launch payload before this checkpoint.
