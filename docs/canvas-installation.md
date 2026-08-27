# Canvas Developer Key setup (Phase 3 manual verification)

This is the one-time, per-institution manual setup needed to launch this tool from a real Canvas
course, and the checklist for verifying an instructor launch works end-to-end. The automated test
suite (`npm test`) already covers all 24 cases in spec §45 against a mocked Canvas platform; this
document is only for the real-Canvas verification step required by this plan's Definition of Done.

## 1. Create the Developer Key

1. In Canvas, go to **Admin → Developer Keys → + Developer Key → + LTI Key**, and choose **Manual
   Entry** (this project does not implement dynamic registration in Phase 3; deep linking is an
   explicit non-goal per the spec).
2. **Redirect URIs**: `https://<APP_BASE_URL>/lti/launch` (this is where Canvas form-POSTs the
   signed `id_token`).
   **Target Link URI**: `https://<APP_BASE_URL>/index.html` — **not** `/lti/launch`. Canvas copies
   this value into the launch's `target_link_uri`, and `/lti/launch` redirects the browser to it
   after a successful launch (`POST /lti/launch` → 303 → this URL). Pointing it at `/lti/launch`
   would redirect the launch endpoint back to itself. Whatever you put here must also appear
   verbatim in `ALLOWED_TARGET_LINK_URIS` (step 5.1 below), which is the exact-match allowlist that
   makes that redirect safe.
   **OIDC Initiation URL**: `https://<APP_BASE_URL>/lti/login`.
   **JWK Method**: Public JWK URL → `https://<APP_BASE_URL>/lti/jwks`.
   **Privacy Level**: `Name Only`.
3. Enable the NRPS and AGS scope checkboxes now, even though this app doesn't call those services
   until Phase 4/6 -- this one Developer Key is reused through those later phases. **Use whatever
   scope strings Canvas's own UI populates; never hand-type or hardcode a scope URN.**
4. **Course Navigation placement**: enabled, label `Attendance`, **Default Visibility: Admins**,
   **Window Target: `_blank`** (required -- Canvas iframes don't delegate WebHID permissions, which
   this app's scanner needs).
5. Save, toggle the key **On**, and copy its **Client ID**.

## 2. Install it in your test course

1. In the Canvas test course: **Settings → Apps → + App → By Client ID**, paste the Client ID,
   install it, and note the generated **Deployment ID** (shown after installation).

## 3. Fetch Canvas's real endpoints

**Never derive these from the Canvas hostname by pattern-matching a URL** -- the spec explicitly
forbids this, because Canvas's actual issuer/JWKS/token endpoints do not follow a fixed pattern
across all Canvas instances. Fetch them for real:

```bash
curl -s https://<canvas-domain>/.well-known/openid-configuration | jq '{issuer, authorization_endpoint, token_endpoint}'
curl -s https://<canvas-domain>/api/lti/security/jwks | jq '.keys | length'   # just to confirm it responds
```

Use the `authorization_endpoint` value as `--oidc-auth-endpoint`, `token_endpoint` as
`--token-endpoint`, and `https://<canvas-domain>/api/lti/security/jwks` as `--platform-jwks-uri`.

## 4. Seed the registration

Run `server/src/database/seed-registration.ts` (see its usage comment) with the issuer, client ID,
endpoints, and deployment ID gathered above, against whichever `DATABASE_URL` your deployed/local
instance of this app is using.

## 5. Verify the launch

1. Set `ALLOWED_TARGET_LINK_URIS` to include the exact **Target Link URI** you configured in step
   1.2 — `https://<APP_BASE_URL>/index.html` — since that is the page `/lti/launch` redirects to on
   success. (The list may hold several entries, e.g. `/index.html,/scanner.html`; a launch is
   redirected to whichever one Canvas sent, not to the first.) Also set
   `LTI_TOOL_SIGNING_KEYS_JSON` if this isn't a
   throwaway dev instance (otherwise a restart rotates the signing key and Canvas's cached JWKS
   fetch may briefly go stale).
2. From the test course, launch **Attendance** as an instructor.
3. Confirm: a new browser tab opens (per spec §8's window-target requirement), the launch
   completes without error, the browser lands on the scanner UI, and a session cookie
   (`attendance_session`) is set.
4. Attempt or simulate a learner-role launch of the same tool (e.g. a test student account, or a
   Canvas "Student View" launch if your Canvas instance's Student View sends learner-role claims).
   Confirm it returns **HTTP 403** and does **not** set a session cookie.
5. If step 4 fails in a way that suggests Canvas's real role-claim URIs differ from
   `server/src/lti/roles.ts`'s `AUTHORIZED_INSTRUCTOR_ROLE_URIS` set, capture the actual `roles`
   claim from a real launch (e.g. via a temporary debug log statement, removed before committing)
   and update that set to match -- this set was written from the standard 1EdTech role vocabulary
   but has not yet been verified against a real Canvas launch payload before this checkpoint.
