# Canvas LTI Attendance Tracker

## Engineering and Implementation Specification

**Status:** Proposed implementation specification
**Target:** LTI 1.3 / LTI Advantage integration with Instructure Canvas
**Primary use case:** Instructor-operated classroom attendance using a browser-connected HID card reader
**Reference deployment:** Microsoft Azure
**Application architecture:** Portable Docker-based Node.js/TypeScript application with PostgreSQL
**Repository model:** Single repository containing frontend, backend, infrastructure, tests, and documentation

---

# 1. Purpose

Extend the existing browser-based Attendance Tracker into a production-capable Canvas LTI 1.3 application.

The application shall allow an instructor to:

1. launch Attendance from a Canvas course;
2. automatically obtain the Canvas course and roster;
3. connect a supported HID card reader;
4. scan student ID cards;
5. resolve each physical card identifier to an institutional student identifier;
6. match that identity against the Canvas roster;
7. maintain an authoritative attendance record;
8. correct attendance manually when necessary;
9. calculate a configurable attendance grade; and
10. publish that grade to the Canvas Gradebook using LTI Advantage.

The application must remain sufficiently generic for deployment by institutions other than the original university. Institution-specific identity systems, card APIs, domains, grading policies, infrastructure, and Canvas registrations must be configuration or adapters rather than application assumptions.

This document is normative. Requirements using **MUST**, **MUST NOT**, **SHOULD**, and **MAY** should be interpreted accordingly.

---

# 2. Existing Application

The implementation must build upon the existing `attendance-tracker` repository rather than replacing it wholesale.

The current application is a plain HTML/CSS/JavaScript single-page application. It has no framework, build process, backend, or npm dependency. It uses WebHID to communicate with an HID Global OMNIKEY reader, performs card-to-person lookups, optionally checks scanned students against an uploaded CSV roster, records attendance in the browser, and exports CSV.

The current source is already reasonably modular, including separate modules for HID transport, OMNIKEY packet parsing, lookup, roster processing, scan orchestration, diagnostics, CSV generation, persistence, and UI behavior.

## 2.1 Existing functionality that MUST be preserved

The following existing behaviors should survive the LTI conversion:

* WebHID reader connection and reconnection.
* HID vendor filtering.
* OMNIKEY Custom Report packet parsing.
* Detection and reporting of unsupported browsers.
* HTTPS/secure-context enforcement.
* Reader diagnostics.
* Raw HID report diagnostics in debug mode.
* Duplicate-scan suppression.
* Asynchronous identity lookup without blocking subsequent scans.
* Correct correlation of out-of-order lookup responses.
* Retry of a failed lookup when the same card is scanned again.
* Prominent display of the latest successful or unsuccessful scan.
* Audible and visual warning for an unexpected student.
* Ability to remove an erroneous attendance record.
* Ability to clear a session with confirmation.
* CSV export.
* A mock identity resolver for development and demonstration.
* Graceful lookup errors rather than silently discarding scans.

The existing `ScanPipeline` is particularly important. It deliberately starts identity lookups asynchronously, correlates each response back to its original record, prevents slow older responses from overwriting a newer "latest scan" display, suppresses duplicate taps, and retries failed lookups in place. Those semantics should be retained and tested during the refactor.

## 2.2 Existing functionality to replace

The following behaviors are transitional and SHOULD be replaced in production LTI mode:

### Browser-stored API credentials

The current application accepts card-lookup credentials in the UI, stores them in browser storage, and interpolates them into lookup requests.

Production LTI mode MUST remove this behavior. Card-system credentials belong on the backend.

### Direct browser-to-card-API calls

The current application calls the institutional identity service directly and therefore depends on that service permitting the frontend origin through CORS.

Production LTI mode MUST send scans to the application backend instead. The backend will call the institution's identity resolver server-to-server.

### Uploaded Canvas roster CSV

The existing CSV roster parser is useful and SHOULD remain available as a development/manual-fallback facility. In normal Canvas operation, the roster MUST come from Canvas through LTI Names and Role Provisioning Service.

### Local browser storage as authoritative attendance storage

The current optional persistence mechanism saves attendance, roster data, duplicate counters, and preferences in `localStorage`.

In LTI mode, PostgreSQL MUST become the authoritative store.

Browser storage MAY retain harmless UI preferences. It MUST NOT store LTI secrets, Canvas access tokens, card-resolver secrets, or the LTI private signing key.

---

# 3. Goals

The first production release SHALL provide:

* LTI 1.3 login and launch.
* Instructor/admin access from Canvas Course Navigation.
* Top-level/new-tab launch suitable for WebHID.
* Canvas roster retrieval using NRPS.
* Pluggable card-to-person resolution.
* Persistent attendance sessions.
* Persistent individual attendance records.
* Instructor corrections.
* Cumulative attendance grading.
* Canvas Gradebook integration using AGS.
* CSV export.
* Audit logging.
* Production security controls.
* Docker packaging.
* Infrastructure as code.
* Automated testing.
* GitHub Actions CI/CD.
* Reference Azure deployment.
* Multi-institution-capable internal architecture.

---

# 4. Non-goals for the first release

Do not implement these unless necessary to satisfy another requirement:

* Canvas REST API OAuth on behalf of individual users.
* Student-facing attendance-taking.
* Face recognition.
* NFC access through native applications.
* Canvas Roll Call synchronization.
* seating charts;
* attendance analytics or predictive analytics;
* parent notifications;
* SIS write-back;
* mobile Safari/Firefox support for card scanning;
* Deep Linking;
* one Canvas assignment per class meeting;
* Kubernetes as the reference deployment;
* custom password-based user accounts.

The application should authenticate instructors through LTI. Do not add a second authentication system merely because web applications apparently enjoy collecting authentication systems.

---

# 5. High-level architecture

The production architecture shall be:

```text
                        Canvas
                           |
                    LTI 1.3 / OIDC
                           |
                           v
                +----------------------+
                | Attendance Web App   |
                | Node.js / TypeScript |
                |                      |
                | LTI                  |
                | Session/Auth         |
                | NRPS                 |-------> Canvas roster
                | AGS                  |-------> Canvas Gradebook
                | Attendance API       |
                | Identity Resolver    |-------> Institution identity API
                +----------+-----------+
                           |
                           v
                    +-------------+
                    | PostgreSQL  |
                    +-------------+

Instructor browser
        |
        +---- HTTPS ----> Attendance Web App
        |
        +---- WebHID ---> Physical card reader
```

The frontend and backend MUST use the same public origin whenever practical.

This eliminates CORS between the browser application and its own API and reduces the security surface.

---

# 6. Repository structure

Use one repository.

Recommended target layout:

```text
attendance-tracker/
├── web/
│   ├── index.html
│   ├── styles.css
│   ├── app.js
│   ├── ui.js
│   ├── hid-reader.js
│   ├── omnikey-parser.js
│   ├── scan-pipeline.js
│   ├── diagnostics.js
│   ├── csv.js
│   ├── roster.js
│   └── ...
│
├── server/
│   ├── src/
│   │   ├── index.ts
│   │   ├── config/
│   │   ├── auth/
│   │   ├── lti/
│   │   │   ├── login.ts
│   │   │   ├── launch.ts
│   │   │   ├── claims.ts
│   │   │   ├── jwks.ts
│   │   │   ├── token-client.ts
│   │   │   ├── nrps.ts
│   │   │   └── ags.ts
│   │   ├── attendance/
│   │   ├── identity/
│   │   │   ├── types.ts
│   │   │   ├── mock-resolver.ts
│   │   │   └── http-resolver.ts
│   │   ├── database/
│   │   ├── audit/
│   │   ├── security/
│   │   └── telemetry/
│   └── tests/
│
├── packages/
│   └── shared/
│
├── infra/
│   └── azure/
│       ├── main.bicep
│       ├── modules/
│       └── environments/
│
├── migrations/
├── docs/
│   ├── architecture.md
│   ├── canvas-installation.md
│   ├── security.md
│   ├── operations.md
│   ├── development.md
│   └── identity-resolvers.md
│
├── .github/
│   └── workflows/
│       ├── pull-request.yml
│       ├── deploy-dev.yml
│       ├── deploy-stage.yml
│       └── deploy-prod.yml
│
├── Dockerfile
├── package.json
├── package-lock.json
└── README.md
```

Use npm workspaces unless an existing institutional standard dictates otherwise.

---

# 7. Reference application stack

The recommended reference implementation is:

| Concern             | Technology                                |
| ------------------- | ----------------------------------------- |
| Runtime             | Node.js 22 LTS                            |
| Language            | TypeScript                                |
| HTTP server         | Fastify                                   |
| JWT/JWK/OIDC crypto | `jose`                                    |
| Input validation    | Zod or equivalent                         |
| Database            | PostgreSQL                                |
| DB access           | Drizzle ORM or equivalent typed SQL layer |
| Unit tests          | Vitest                                    |
| Browser tests       | Playwright                                |
| Logging             | structured JSON logging with redaction    |
| Metrics/traces      | OpenTelemetry                             |
| Packaging           | Docker                                    |
| CI/CD               | GitHub Actions                            |
| IaC                 | Bicep for reference Azure deployment      |

Use established cryptographic/JWT libraries. **Do not implement RSA, JWS, JWT signature verification, base64url encoding, or key parsing manually.**

A maintained LTI 1.3 library MAY replace portions of the LTI implementation if it satisfies all validation and security requirements specified below. Tests in this document remain mandatory regardless of library.

---

# 8. Why the scanner must launch in a new tab

WebHID strongly influences the UI architecture.

WebHID requires a secure context, and the initial device chooser requires a user gesture.

More importantly, the browser Permissions Policy for `hid` defaults to `self`. A cross-origin iframe does not automatically receive WebHID capability.

Canvas Course Navigation supports configuring an LTI tool with `windowTarget` set to `_blank`, causing the LTI launch to occur in a new tab rather than an iframe.

Therefore:

**Production Canvas installations MUST configure the attendance application to launch in a new browser tab.**

Do not depend on Canvas delegating WebHID permissions to an iframe.

---

# 9. LTI version and capabilities

Implement:

* **LTI 1.3 Core**
* **LTI Advantage Names and Role Provisioning Service 2.0**
* **LTI Advantage Assignment and Grading Services 2.0**

Do not implement LTI 1.1.

Canvas explicitly recommends LTI 1.3/AGS for new grading integrations and supports returning grades even if students never launch the external tool. It also permits tools to create Gradebook line items programmatically.

No general Canvas REST API token is required for the MVP. NRPS can retrieve course membership without a separate Canvas REST authorization flow.

---

# 10. Canvas registration

The application must expose these logical endpoints:

```text
${APP_BASE_URL}/lti/login
${APP_BASE_URL}/lti/launch
${APP_BASE_URL}/lti/jwks
```

The Canvas registration shall request only these capabilities:

```text
NRPS context membership: read-only
AGS line items: read/write
AGS scores: write
```

The exact standardized scope identifiers MUST be taken from the current Canvas LTI configuration documentation rather than duplicated as application-specific strings. Canvas currently documents these scopes in its LTI Developer Key configuration reference.

The application does not initially require the AGS Result read scope.

## 10.1 Course Navigation placement

Configure:

```text
placement: course_navigation
message type: LtiResourceLinkRequest
window target: _blank
visibility: admins
enabled: true
label: Attendance
```

In Canvas's current Admin → Apps registration UI, `window target: _blank` (JSON key `windowTarget`)
and the NRPS/AGS `scopes` are not exposed as form fields — they can only be supplied through the JSON
configuration method. `docs/canvas-installation.md` gives the full JSON.

In a course placement, Canvas's `admins` visibility includes administrators and instructors rather than learners.

Visibility is a UI convenience, **not an authorization control**. The backend must independently validate the LTI role claim.

## 10.2 Privacy level

Recommended default:

```text
privacy_level = name_only
```

Canvas NRPS includes `lis_person_sourcedid` when privacy is `public` or `name_only`; email requires `public` or `email_only`.

The application should avoid requesting email unless an institution actually needs it.

---

# 11. Multi-institution registration model

Do **not** identify an institution solely by the LTI `iss` claim.

Instructure-hosted production Canvas instances share a common Canvas issuer regardless of the institution's individual Canvas domain. Canvas similarly uses common beta and test issuers.

The tenant/deployment identity must therefore use:

```text
issuer
+ client_id
+ deployment_id
```

This also follows the LTI 1.3 deployment model, where a registration is identified by issuer/client ID and individual deployments receive a deployment ID.

Store institution registrations in the database.

Example logical configuration:

```text
Institution
  id
  displayName

LtiRegistration
  institutionId
  issuer
  clientId
  oidcAuthorizationEndpoint
  tokenEndpoint
  tokenAudience
  platformJwksUri

LtiDeployment
  registrationId
  deploymentId
  enabled
```

Never derive endpoints by manipulating the institution's Canvas hostname.

Store the endpoints received/configured during LTI registration explicitly.

---

# 12. LTI OIDC login flow

Canvas uses the LTI-defined OIDC third-party login flow.

## 12.1 Login initiation

Canvas sends the browser to:

```text
POST or GET /lti/login
```

Expected parameters include:

```text
iss
login_hint
target_link_uri
client_id
lti_deployment_id
lti_message_hint
```

`lti_deployment_id` is the LTI 1.3 OIDC login-initiation parameter name (this is what Canvas
sends). The bare `deployment_id` spelling is the `id_token` *claim* name used at launch
(`https://purl.imsglobal.org/spec/lti/claim/deployment_id`), not the login parameter.

`lti_message_hint` is an opaque value Canvas mints per launch; the tool MUST echo it unchanged on
the authorization request (step 6). Canvas rejects the redirect (`lti_message_hint is missing`)
otherwise.

On receipt:

1. Validate that `iss`, `client_id`, and `lti_deployment_id` identify an enabled configured deployment.
2. Validate `target_link_uri` against an explicit allowlist of this application's own launch destinations.
3. Generate a cryptographically random `state`.
4. Generate a cryptographically random OIDC `nonce`.
5. Store an LTI transaction.
6. Redirect the user's browser to the configured Canvas OIDC authorization endpoint.

Canvas requires this authorization request to occur through the user's browser rather than server-to-server because Canvas must validate the user's Canvas session.

The authorization request shall contain at minimum the LTI/OIDC-required values:

```text
client_id
login_hint
redirect_uri
state
nonce
response_type = id_token
response_mode = form_post
scope = openid
prompt = none
lti_message_hint      # echoed unchanged from the login initiation
```

`redirect_uri` MUST exactly match an authorized Canvas Developer Key redirect URI. Canvas validates this before posting the launch token.

## 12.2 State and nonce

Generate at least 256 bits of cryptographically random entropy.

Store only hashes where practical:

```text
state_hash
nonce_hash
registration_id
deployment_id
target_link_uri
created_at
expires_at
consumed_at
```

Recommended transaction lifetime:

```text
5 minutes
```

Transactions MUST be single-use.

A successful launch MUST atomically mark the transaction consumed.

A replay MUST fail.

## 12.3 Transaction cookie

Because the intended launch is top-level rather than embedded, the login endpoint MAY also set a short-lived transaction cookie to bind the OIDC transaction to the same browser.

Recommended properties:

```text
HttpOnly
Secure
SameSite=None
Path=/lti
Max-Age=300
```

The backend MUST NOT rely solely on the cookie. The server-side state transaction remains authoritative.

Canvas provides LTI Platform Storage specifically to address state storage problems in third-party iframe contexts. Because this application intentionally launches top-level, Platform Storage is not required for the MVP. If iframe support is later added, implement Canvas Platform Storage rather than assuming third-party cookies will work.

---

# 13. LTI launch validation

Canvas sends the authenticated launch to:

```text
POST /lti/launch
```

The request includes:

```text
state
id_token
```

The backend MUST perform every validation below before creating an application session.

## 13.1 State

* locate the pending OIDC transaction;
* constant-time compare where applicable;
* verify it is unexpired;
* verify it has not previously been consumed;
* verify deployment context;
* consume it atomically.

## 13.2 JWT signature

Validate the JWT signature using the configured Canvas platform JWKS.

Do not accept an unsigned JWT.

Do not accept an algorithm selected merely because the incoming JWT asks for it.

The reference implementation shall permit the LTI-required RSA signing algorithm and explicitly reject unsupported algorithms.

1EdTech states that private keys are fundamental to the LTI trust model, recommends established libraries, and requires support for RSA SHA-256 with RSA keys of at least 2048 bits.

## 13.3 JWKS behavior

Cache Canvas public keys by:

```text
issuer + kid
```

On an unknown `kid`:

1. re-fetch the configured JWKS once;
2. retry validation;
3. fail if the key is still unavailable.

Do not silently try every configured institution's keys.

1EdTech specifically recommends caching by issuer/key ID while re-querying JWKS when an unknown `kid` appears so that key rotation does not break integrations.

## 13.4 Issuer

`iss` MUST exactly equal the configured issuer.

Reject unknown issuers.

## 13.5 Audience

The token's `aud` MUST contain this registration's Canvas `client_id`.

If the audience contains multiple values, validate `azp` according to OpenID Connect/LTI requirements.

Reject unexpected audience values.

1EdTech explicitly requires rejecting launch tokens whose issuer or audience does not match the trusted registration.

## 13.6 Lifetime

Validate:

```text
exp
iat
nbf, if provided
```

Permit only a small configurable clock skew.

Recommended:

```text
CLOCK_SKEW_SECONDS = 120
```

Reject tokens that are expired or implausibly issued in the future.

## 13.7 Nonce

The token's nonce MUST match the nonce associated with the OIDC transaction.

The nonce MUST be single-use.

This provides replay protection separate from `state`.

## 13.8 LTI claims

Require:

```text
version == 1.3.0
message_type == LtiResourceLinkRequest
deployment_id == configured deployment
context claim exists
roles claim exists
```

Do not perform authorization based on display names or other unsigned/request parameters.

## 13.9 Role authorization

Allow the attendance UI only for recognized LTI instructor/administrator roles.

Learner-only launches MUST receive HTTP 403 and MUST NOT create an instructor session.

Do not use substring matching such as:

```text
role.includes("Instructor")
```

Normalize and compare complete standardized role identifiers.

---

# 14. Application session after LTI launch

After successful launch validation:

1. create an opaque application session;
2. store only the hashed session token in PostgreSQL;
3. set an opaque session cookie;
4. return HTTP 303 to the actual scanner UI.

Recommended cookie:

```text
HttpOnly
Secure
SameSite=Lax
Path=/
```

Recommended session lifetime:

```text
8 hours
```

The application should not use a client-readable JWT as its own browser session token unless there is a concrete requirement for stateless sessions.

Opaque server-side sessions provide:

* explicit revocation;
* simpler tenant isolation;
* easier role changes;
* less sensitive data in browser storage.

---

# 15. CSRF protection

All state-changing application API requests MUST require:

1. the authenticated session cookie;
2. an exact expected `Origin` header;
3. a session-bound CSRF token in a custom request header.

The browser frontend receives its CSRF token through a same-origin authenticated bootstrap endpoint.

Reject form-encoded mutation endpoints except the LTI launch endpoint itself.

---

# 16. Canvas LTI service authentication

NRPS and AGS use OAuth 2.0 Client Credentials.

Canvas requires the tool to submit a signed JWT client assertion when requesting the service access token.

The token request includes:

```text
grant_type = client_credentials

client_assertion_type =
urn:ietf:params:oauth:client-assertion-type:jwt-bearer

client_assertion = <signed JWT>

scope = <space-separated required scopes>
```

The client assertion MUST:

* use the active tool signing key;
* use RSA SHA-256;
* include the active `kid`;
* contain the Canvas `client_id` as `sub`;
* use the configured authorization-server audience;
* contain short `iat` and `exp` values;
* contain a unique `jti`.

Use a short assertion lifetime, e.g. five minutes or less.

Canvas documents that the assertion's `sub` must match the Developer Key client ID and that the `kid` must match a key published through the tool's configured JWK set when a JWKS URL is used.

## 16.1 Access-token cache

Cache Canvas service tokens server-side by:

```text
registration
+ normalized scope set
```

Use the token until approximately 60 seconds before its declared expiration.

Never expose a Canvas access token to browser JavaScript.

Never persist access tokens in logs.

---

# 17. Tool signing keys

The application must own an RSA signing key pair for LTI service authentication.

Expose public keys through:

```text
GET /lti/jwks
```

The JWKS response shall contain:

```text
kid
kty
use
alg
n
e
```

Only public key material may appear here.

## 17.1 Private-key storage

Private keys MUST NOT exist:

* in Git;
* in the frontend bundle;
* in browser storage;
* in GitHub Actions secrets unless an unavoidable deployment mechanism requires it;
* in application logs;
* in Docker images;
* in checked-in `.env` files.

For Azure, store the signing key in Azure Key Vault and grant the runtime access via Managed Identity. Azure Container Apps can obtain Key Vault-backed secrets through managed identity rather than storing the secret directly in deployment configuration.

A stronger future implementation MAY use a non-exportable Key Vault asymmetric key and remote signing.

## 17.2 Rotation

Support at least:

```text
active signing key
previous signing key(s)
```

The JWKS endpoint publishes active and still-valid previous public keys.

Only the active key signs new assertions.

Retain the old public key through a configurable overlap period; seven days is a reasonable default.

Key rotation MUST NOT require code changes.

---

# 18. Canvas roster integration

Use NRPS as the authoritative current Canvas roster.

Canvas's NRPS requires the context-membership read scope and returns standardized membership data including status, roles, LTI user ID, and—depending on privacy configuration—names, email, and the primary SIS identifier.

## 18.1 Endpoint discovery

Do not construct the NRPS URL manually if Canvas supplies it in the signed launch claims.

Persist the signed service endpoint from the launch after validating the launch.

Before using it, enforce:

* HTTPS;
* expected host/platform relationship;
* no user-controlled redirection.

## 18.2 Roster filtering

By default, attendance candidates must be:

```text
status = Active
AND role contains Learner
```

Do not mark instructors, TAs, observers, or designers absent.

Provide a configuration mechanism for institutions that use custom roles.

## 18.3 Roster snapshot

On `Start Attendance Session`:

1. refresh the Canvas roster;
2. create a roster snapshot;
3. associate that snapshot with the attendance session.

Historical attendance must not retroactively change merely because a student is later added or dropped from the course.

## 18.4 Roster caching

Cache live roster data briefly to avoid needless Canvas traffic.

Recommended:

```text
5 minutes
```

Provide an instructor-visible **Refresh Roster** action.

---

# 19. Identity resolution abstraction

A physical card identifier is institution-specific and is not part of LTI.

Implement an adapter interface.

Conceptual TypeScript:

```ts
interface IdentityResolver {
  resolveCard(cardCode: string): Promise<IdentityResolution>;
}

interface IdentityResolution {
  ok: boolean;
  institutionalId: string | null;
  givenName?: string | null;
  familyName?: string | null;
  email?: string | null;
  metadata?: Record<string, unknown>;
  error?: {
    kind: string;
    message: string;
    retryable: boolean;
  };
}
```

The frontend must not know the institution's identity API shape.

This follows the good separation already present in the existing `lookup.js`, which normalizes arbitrary lookup-service fields into a stable student identity result and always returns a predictable success/error shape.

## 19.1 Required adapters

Initially implement:

```text
MockIdentityResolver
HttpIdentityResolver
```

The mock resolver should preserve the useful deterministic behavior already available in the project.

## 19.2 HTTP resolver configuration

Support institution-defined:

```text
method
base URL/template
timeout
authentication mechanism
request headers
response ID path
given-name path
family-name path
email path
```

Preferred authentication mechanisms:

1. bearer/header secret;
2. API-key header;
3. mutual TLS, later if required.

Credentials in query strings SHOULD be discouraged.

Legacy APIs requiring query-string credentials MAY be supported, but:

* the fully rendered request URL must never be logged;
* query values must be redacted from telemetry;
* credentials must remain server-side.

## 19.3 Timeout

Default identity lookup timeout:

```text
5 seconds
```

The current application's lookup path already uses a five-second abort timeout and differentiates timeout, network, HTTP, JSON, and missing-identity errors. Preserve equivalent error semantics.

---

# 20. Matching card identity to Canvas identity

Do not assume every institution uses the same identifier.

Define an institution setting:

```text
canvasIdentityMatchField
```

Recommended default:

```text
lis_person_sourcedid
```

The resolved institutional ID is normalized as a trimmed string.

Never convert IDs to integers. Leading zeroes may be meaningful; the existing application correctly treats roster IDs as strings.

Supported matching strategies MAY include:

```text
lis_person_sourcedid
email
custom Canvas field available in launch/NRPS
institution-provided mapping adapter
```

Rules:

* Never match by student name.
* Email matching must be explicitly enabled.
* Multiple matches are an error.
* No match is an `unexpected` scan.
* A card lookup failure is not the same as an unexpected student.
* An ambiguous match MUST NOT mark anyone present.

---

# 21. Browser scan flow

A normal successful scan is:

```text
Reader
  |
  v
hid-reader.js
  |
  v
omnikey-parser.js
  |
  v
scan-pipeline.js
  |
  v
POST /api/sessions/{sessionId}/scans
  |
  +--> institutional IdentityResolver
  |
  +--> roster match
  |
  +--> database
  |
  v
normalized scan response
  |
  v
UI
```

The frontend sends:

```json
{
  "clientScanId": "<UUID>",
  "cardCode": "<raw HID card code>",
  "scannedAt": "<ISO timestamp>"
}
```

The server returns a normalized attendance record.

`clientScanId` MUST be unique per client scan.

A database uniqueness constraint shall make scan submission idempotent.

If the same request is retried because the HTTP response was lost, the backend MUST return the previously-created result rather than add another attendance record.

---

# 22. Raw card identifier handling

A raw card code is sensitive institutional identity data.

It should exist only as long as required to perform the lookup.

## Production rules

The server MUST NOT:

* write raw card codes to request logs;
* write raw card codes to audit logs;
* include raw card codes in exception reporting;
* include raw card codes in routine telemetry;
* persist them in the attendance record by default.

If an institution requires a durable card reference for diagnostics, store:

```text
HMAC-SHA256(rawCardCode, institution-specific secret)
```

rather than the raw code.

Treat the resulting fingerprint as sensitive/pseudonymous data.

The frontend MAY retain raw card codes in memory during the active browser session because the current duplicate-suppression algorithm requires them.

LTI production mode SHOULD NOT persist raw card codes to localStorage.

---

# 23. Attendance session model

Attendance revolves around an explicit class meeting.

States:

```text
open
closed
reopened
```

Typical workflow:

1. instructor launches tool;
2. selects **Start Attendance**;
3. server snapshots roster;
4. instructor connects reader;
5. students scan;
6. instructor corrects any records;
7. instructor selects **Close Attendance**;
8. students with no qualifying record become absent;
9. cumulative grades are recalculated;
10. grades are synchronized to Canvas.

A closed session is immutable to normal scanning.

An instructor may reopen it explicitly.

Reopening and closing MUST create audit records.

---

# 24. Attendance statuses

Core statuses:

```text
present
absent
late
excused
lookup_error
unexpected
```

`lookup_error` and `unexpected` are operational scan states and do not automatically map to a student grade.

An institution may configure additional statuses later.

Do not hard-code grading policy into the scan pipeline.

---

# 25. Backend API

All `/api/*` routes require an authenticated instructor application session unless explicitly documented otherwise.

## 25.1 Session/bootstrap

```text
GET /api/me
```

Returns:

```json
{
  "user": {
    "displayName": "...",
    "roles": ["..."]
  },
  "institution": {
    "name": "..."
  },
  "course": {
    "id": "...",
    "label": "...",
    "title": "..."
  },
  "permissions": {
    "takeAttendance": true,
    "editAttendance": true
  },
  "csrfToken": "..."
}
```

Do not expose Canvas access tokens or service URLs to the browser.

## 25.2 Roster

```text
GET /api/course/roster
POST /api/course/roster/refresh
```

Return normalized members rather than raw NRPS payloads.

## 25.3 Create attendance session

```text
POST /api/attendance-sessions
```

Optional body:

```json
{
  "label": "Class meeting",
  "meetingAt": "<ISO timestamp>"
}
```

Server supplies course and instructor from authenticated LTI context.

Never trust the browser to choose an arbitrary Canvas course ID.

## 25.4 Retrieve session

```text
GET /api/attendance-sessions/{id}
```

Must verify that the session belongs to the authenticated institution/course.

## 25.5 Scan

```text
POST /api/attendance-sessions/{id}/scans
```

Accept one card scan.

The backend must record a lookup-error event instead of silently losing the scan when the identity resolver fails.

## 25.6 Manual attendance update

```text
PATCH /api/attendance-sessions/{id}/members/{ltiUserId}
```

Example:

```json
{
  "status": "excused",
  "note": "Institution-approved absence"
}
```

Manual changes require audit logging.

## 25.7 Close

```text
POST /api/attendance-sessions/{id}/close
```

This endpoint:

1. locks/finalizes the session transactionally;
2. marks remaining roster members absent;
3. recalculates cumulative attendance;
4. queues Canvas grade synchronization.

## 25.8 Reopen

```text
POST /api/attendance-sessions/{id}/reopen
```

Must audit actor/time/reason.

## 25.9 Grade retry

```text
POST /api/attendance-sessions/{id}/grade-sync
```

Available when previous Canvas grade synchronization failed.

## 25.10 CSV

```text
GET /api/attendance-sessions/{id}/export.csv
```

Preserve the useful CSV export capability from the existing application.

## 25.11 History, soft delete, restore

```text
GET  /api/attendance-sessions/history[?includeDeleted=1]
DELETE /api/attendance-sessions/{id}
POST /api/attendance-sessions/{id}/restore
```

`history` lists the course's sessions newest-first by `opened_at` (soft-deleted
excluded unless `includeDeleted=1`). `DELETE` is a soft delete: it sets
`attendance_sessions.deleted_at` / `deleted_by_lti_user_id`, is restorable, and —
when the session was `closed` — recomputes the course's cumulative attendance
grades from the remaining non-deleted closed sessions. It responds `200 { ok: true, lastClosedSessionRemoved }`. When the deleted session
was the course's **last** closed session there is nothing left to recompute from:
the course's `grade_sync_jobs` are purged and the cumulative Canvas line item is
flagged for durable removal on `grade_line_items` (`delete_requested_at` +
`delete_next_attempt_at`, audited `grade_line_item_delete_requested`). The grade-sync worker's line-item-deletion pass then
issues the AGS `DELETE` (a Canvas `404` counts as already removed), drops the
`grade_line_items` row, and audits `grade_line_item_deleted`. `lastClosedSessionRemoved`
is `true` so the client can tell the instructor the column is being removed. A later
close or restore in the course cancels a still-pending removal
(`grade_line_item_delete_canceled`); the next recompute recreates the line item
idempotently via `ensureLineItem` (spec §27.1). `POST /grade-sync` re-arms a removal
that hit its retry ceiling (`grade_line_item_delete_failed`). `restore` is the inverse. Both audit actor + time and,
when a recompute ran, emit `grade_sync_requested`. Editing a past session is
unchanged: reopen it, correct records, close it.

---

# 26. PostgreSQL data model

Names are illustrative.

## `institutions`

```text
id UUID PK
slug
display_name
timezone
enabled
created_at
updated_at
```

## `lti_registrations`

```text
id UUID PK
institution_id FK
issuer
client_id
oidc_auth_endpoint
token_endpoint
token_audience
platform_jwks_uri
enabled
created_at
updated_at

UNIQUE(issuer, client_id)
```

## `lti_deployments`

```text
id UUID PK
registration_id FK
deployment_id
enabled
configuration JSONB
created_at
updated_at

UNIQUE(registration_id, deployment_id)
```

## `oidc_transactions`

```text
id UUID PK
registration_id FK
deployment_id
state_hash
nonce_hash
target_link_uri
created_at
expires_at
consumed_at

UNIQUE(state_hash)
```

Periodically purge expired transactions.

## `app_sessions`

```text
id UUID PK
session_token_hash
institution_id FK
deployment_id FK
lti_subject
course_id FK
roles JSONB
csrf_secret
created_at
last_seen_at
expires_at
revoked_at
```

## `courses`

```text
id UUID PK
institution_id FK
deployment_id FK
lti_context_id
label
title
nrps_url
ags_lineitems_url
last_launched_at
created_at
updated_at

UNIQUE(deployment_id, lti_context_id)
```

## `course_members`

```text
id UUID PK
course_id FK
lti_user_id
institutional_id nullable
display_name nullable
given_name nullable
family_name nullable
email nullable
roles JSONB
status
last_seen_at

UNIQUE(course_id, lti_user_id)
```

## `attendance_sessions`

```text
id UUID PK
course_id FK
started_by_lti_user_id
label
meeting_at
opened_at
closed_at nullable
state
roster_snapshot_version
created_at
updated_at
```

## `attendance_session_members`

This table is the roster snapshot.

```text
id UUID PK
attendance_session_id FK
lti_user_id
institutional_id nullable
display_name nullable
eligible_for_attendance boolean
status
snapshot_data JSONB
```

## `attendance_records`

```text
id UUID PK
attendance_session_id FK
lti_user_id nullable
institutional_id nullable
client_scan_id nullable
status
scanned_at nullable
source
card_fingerprint nullable
lookup_error_kind nullable
created_at
updated_at

UNIQUE(attendance_session_id, client_scan_id)
```

Possible `source` values:

```text
card
manual
system_absence
import
```

## `grade_line_items`

```text
id UUID PK
course_id FK
canvas_line_item_id
canvas_line_item_url
resource_id
tag
score_maximum
created_at
updated_at
```

## `grade_sync_jobs`

```text
id UUID PK
course_id FK
attendance_session_id nullable
lti_user_id
score
state
attempt_count
last_error
next_attempt_at
created_at
updated_at
```

## `audit_events`

```text
id UUID PK
institution_id FK
course_id nullable
attendance_session_id nullable
actor_lti_user_id nullable
event_type
target_type
target_id
old_value JSONB nullable
new_value JSONB nullable
created_at
request_id
```

Audit values MUST be PII-minimized and MUST NOT contain authentication tokens or raw card identifiers.

---

# 27. Gradebook design

The default strategy is **one cumulative Canvas Gradebook line item per course**:

```text
Attendance
Maximum score: 100
```

Do not create one Gradebook column per class meeting by default.

Detailed meeting-by-meeting attendance remains in the attendance application.

This keeps Canvas Gradebook clean while retaining detailed attendance history.

## 27.1 Creating the line item

AGS permits a tool to create a line item with a label and maximum score. Canvas exposes `resourceId` and `tag`, which can be used to identify a tool-created line item.

Use stable values conceptually equivalent to:

```text
resourceId = attendance-cumulative-v1
tag        = attendance
label      = Attendance
maximum    = 100
```

Before creating a line item:

1. query existing tool line items using the stable tag/resource ID;
2. reuse a matching line item;
3. create only if none exists;
4. persist its returned identifier/URL.

This operation MUST be idempotent.

### Removing the line item

When a course loses its last non-deleted closed session, the tool durably removes
the cumulative line item rather than leaving a stale Gradebook column. The request
is recorded on `grade_line_items` (`delete_requested_at`, `delete_requested_by_lti_user_id`,
`delete_attempt_count`, `delete_next_attempt_at`, `delete_last_error`) inside the
soft-delete transaction — never as a synchronous Canvas call (spec §28). A worker
pass issues the AGS `DELETE`; a Canvas `404` is treated as success. Retryable
failures (429 / 5xx / network / 401) back off with jitter to the shared attempt
ceiling, then terminally fail (`delete_next_attempt_at` NULL) pending a manual
re-arm. A close or restore before the worker runs cancels the request. Recreation
on the next close/restore goes through the same idempotent `ensureLineItem` path.

## 27.2 Grade calculation

Make grading policy configurable by institution.

Suggested default policy:

```text
present -> 1 attendance point
late    -> configurable, default 1
absent  -> 0
excused -> excluded from denominator
```

Then:

```text
score =
  earned eligible attendance points
  ---------------------------------
  possible eligible attendance points
  * 100
```

If the denominator is zero, do not submit a score.

Do not force an institution to adopt this policy; expose policy configuration.

## 27.3 Sending scores

Canvas's AGS Score service requires a user identifier, activity progress, grading progress, and timestamp. When a score is provided, its maximum is also required. Canvas recommends ISO timestamps with subsecond precision and rejects score updates older than the existing result.

Use the student's NRPS `user_id` as the AGS user identifier.

Submit conceptually:

```json
{
  "userId": "<LTI user id>",
  "scoreGiven": 94.5,
  "scoreMaximum": 100,
  "activityProgress": "Completed",
  "gradingProgress": "FullyGraded",
  "timestamp": "<current UTC timestamp with subsecond precision>"
}
```

AGS specifically supports posting grades for students who never launched the attendance tool.

---

# 28. Grade synchronization reliability

Closing attendance must not depend on hundreds of Canvas writes succeeding inside one browser request.

Use a durable `grade_sync_jobs` outbox.

On close:

1. commit attendance;
2. calculate scores;
3. create/update grade-sync jobs in the same database transaction;
4. return success to the instructor;
5. process jobs asynchronously.

The UI should display:

```text
Grades synchronized
Grades pending
Grade synchronization failed
```

Failures must be retryable.

Retry:

* HTTP 429;
* network failures;
* transient 5xx responses.

Do not automatically retry permanent 4xx validation errors indefinitely.

Use exponential backoff with jitter.

Keep Canvas grade writes mostly sequential or low-concurrency to avoid unnecessary throttling; Instructure explicitly discusses request throttling for AGS.

A small scheduled worker is sufficient. No Kafka-shaped attendance system is required.

---

# 29. Frontend refactor

The frontend should remain intentionally lightweight.

Do not introduce React/Vue/etc. merely to move files around.

The existing modular ES implementation is adequate.

## Keep substantially intact

```text
hid-reader.js
omnikey-parser.js
diagnostics.js
ui.js
csv.js
```

## Refactor

### `scan-pipeline.js`

Preserve its concurrency and duplicate-suppression behavior, but replace direct identity lookup with an API submission.

Conceptually:

```text
lookupCard(cardCode)
```

becomes:

```text
submitScan(sessionId, clientScanId, cardCode)
```

The server response remains normalized so existing UI behavior changes minimally.

### `lookup.js`

Replace institutional browser lookup logic with an application API client.

The current mock resolver should move to or be duplicated on the backend for integration testing.

### `credentials.js`

Remove from the production LTI application.

No backend credential should be entered by an instructor.

### `roster.js`

Retain CSV parsing for:

* development;
* demo mode;
* fallback/manual mode.

Normal LTI mode obtains a normalized roster from the backend.

### `storage.js`

In LTI mode:

* server is authoritative;
* local storage may retain UI preferences;
* full student roster should not be persisted locally by default;
* raw card codes should not be persisted locally.

---

# 30. Browser/card-reader support

The existing reader implementation filters on HID Global's vendor identifier while deliberately avoiding a fixed product ID so compatible devices using the same Custom Report format can work.

Keep this as the initial hardware implementation.

Create a future-friendly abstraction:

```ts
interface CardReader {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  reconnectKnownDevices(): Promise<void>;
  onCard(callback: (cardCode: string) => void): void;
}
```

Implement:

```text
OmnikeyWebHidReader
```

Do not generalize the hardware layer before the existing reader path works end-to-end.

---

# 31. Security requirements

## 31.1 TLS

Production MUST use HTTPS only.

Configure HSTS.

Do not permit mixed-content API requests.

## 31.2 Security headers

Recommended baseline:

```text
Strict-Transport-Security
Content-Security-Policy
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Permissions-Policy: hid=(self)
```

Because the production scanner is deliberately top-level, consider:

```text
Content-Security-Policy:
  frame-ancestors 'none'
```

unless another supported LTI placement genuinely requires embedding.

## 31.3 Content Security Policy

Start restrictive:

```text
default-src 'self'
script-src 'self'
style-src 'self'
connect-src 'self'
object-src 'none'
base-uri 'none'
form-action 'self' <configured Canvas OIDC destinations>
```

Adjust only where technically necessary.

Avoid inline JavaScript.

## 31.4 CORS

When frontend and API share an origin:

**Do not enable broad CORS.**

If separate frontend hosting is later required, configure an explicit origin allowlist.

Never use wildcard CORS with credentials.

## 31.5 Input validation

Validate every API request.

Enforce:

* body size limits;
* types;
* maximum string lengths;
* UUID format;
* enum values;
* timestamp sanity.

Do not pass unvalidated request objects directly to database operations or HTTP clients.

## 31.6 SQL

Use parameterized queries/ORM query binding.

Never concatenate user input into SQL.

## 31.7 SSRF

Outbound URLs must come from trusted institution configuration or validated signed LTI service claims.

Never accept an arbitrary URL from the browser and fetch it.

For signed Canvas-provided service endpoints:

* require HTTPS;
* reject embedded credentials;
* validate host against the configured Canvas platform/service-host policy;
* disable unrestricted redirects.

## 31.8 Logging

Do not log:

* `id_token`;
* Canvas access tokens;
* LTI private keys;
* application session cookies;
* CSRF tokens;
* card resolver credentials;
* raw card codes;
* full NRPS payloads.

The existing diagnostics module already deliberately excludes student name/email in some lookup diagnostics. Preserve and strengthen that privacy principle.

## 31.9 Error responses

Production errors must not expose:

* stack traces;
* SQL;
* private hostnames;
* secrets;
* JWTs;
* resolver URLs containing credentials.

Attach a random/request correlation ID.

## 31.10 Rate limiting

Suggested initial limits:

```text
/lti/login:
  30 requests/minute/IP

/lti/launch:
  30 requests/minute/IP

scan API:
  allow classroom bursts;
  approximately 120-240 requests/minute/session
```

Do not impose a rate limit that prevents a class from scanning through quickly.

## 31.11 Dependency controls

* commit lockfiles;
* automated dependency updates;
* dependency vulnerability scanning;
* pin GitHub Actions to trusted releases, preferably commit SHA where institutional policy requires;
* avoid unnecessary packages.

---

# 32. Threat model

| Threat                                 | Required mitigation                                     |
| -------------------------------------- | ------------------------------------------------------- |
| Forged Canvas launch                   | JWT signature validation against configured Canvas JWKS |
| Token sent to wrong tool               | strict `aud` validation                                 |
| Launch from unknown Canvas environment | exact `iss` validation                                  |
| Launch from another deployment         | exact `deployment_id` validation                        |
| Replay                                 | single-use state and nonce                              |
| Login CSRF                             | state + short browser-bound transaction                 |
| Student accessing instructor UI        | LTI role authorization                                  |
| Browser stealing LTI key               | signing key exists only server-side                     |
| Browser stealing Canvas service token  | token exists only server-side                           |
| Cross-site mutation                    | SameSite cookie + Origin + CSRF token                   |
| XSS                                    | restrictive CSP + no secrets in browser                 |
| SQL injection                          | bound parameters + schema validation                    |
| SSRF                                   | configured/signed URL allowlisting                      |
| Card ID disclosure                     | no card logging/persistence by default                  |
| Duplicate scan                         | client suppression + server idempotency                 |
| Lost HTTP response                     | `clientScanId` replay returns existing record           |
| Card API outage                        | persisted lookup-error scan + visible retry             |
| Canvas outage                          | durable grade-sync jobs                                 |
| Cross-institution data access          | tenant/course checks on every query                     |
| Compromised CI secret                  | GitHub→Azure OIDC, no long-lived deployment credential  |

---

# 33. Audit requirements

Audit at minimum:

```text
attendance_session_created
attendance_session_closed
attendance_session_reopened
attendance_manual_change
attendance_record_removed
attendance_session_deleted
attendance_session_restored
roster_refreshed
grade_sync_requested
grade_sync_failed
grade_sync_completed
grade_line_item_delete_requested
grade_line_item_deleted
grade_line_item_delete_failed
grade_line_item_delete_canceled
institution_configuration_changed
```

For attendance corrections record:

```text
actor
timestamp
student identifier
previous status
new status
reason/note if supplied
```

Do not treat request/access logs as the audit log.

---

# 34. Privacy and retention

This project does not itself guarantee FERPA or other regulatory compliance; institutions remain responsible for their policies and deployment. The original application similarly avoided making a specific compliance claim while minimizing unnecessary data movement.

The production application should follow data-minimization principles:

* store the LTI user ID necessary for Canvas;
* store institutional ID when needed for card matching;
* store names primarily for instructor usability;
* omit email unless needed;
* avoid raw card storage;
* avoid complete raw LTI/NRPS payload retention.

Retention MUST be configurable.

Do not hard-code a universal retention period because institutional requirements vary.

Production deployment SHOULD require administrators to explicitly choose:

```text
attendance retention
audit retention
application-log retention
```

Provide a purge job.

---

# 35. Reference Azure infrastructure

The application itself must remain cloud-portable.

The reference Azure deployment consists of:

```text
Resource Group
|
+-- Azure Container Registry
|
+-- Azure Container Apps Environment
|   |
|   +-- attendance-web
|   |
|   +-- attendance-grade-worker
|
+-- Azure Database for PostgreSQL Flexible Server
|
+-- Azure Key Vault
|
+-- Managed Identity
|
+-- Log Analytics / Application Insights
|
+-- DNS / certificate configuration
```

## 35.1 Web Container App

Run the same container that serves:

* static frontend;
* backend API;
* LTI endpoints;
* JWKS endpoint;
* health endpoints.

Suggested starting resources:

```text
0.5 vCPU
1 GiB memory
```

Production:

```text
min replicas = 1
max replicas = 5
```

Development/staging may use:

```text
min replicas = 0
```

Container Apps supports scaling behavior and managed-identity-based authentication to Azure resources.

One warm production replica avoids introducing cold-start latency directly into an instructor's LTI launch.

## 35.2 Worker

Deploy the same image with a different command, e.g.:

```text
node dist/worker.js
```

Run periodically to process:

```text
grade_sync_jobs
expired OIDC transactions
expired application sessions
retention/purge tasks
```

Five-minute grade retry scheduling is sufficient.

## 35.3 PostgreSQL

PostgreSQL is selected over Table Storage because the domain now includes:

* relational course/member/session data;
* transactional session close operations;
* uniqueness/idempotency constraints;
* audit history;
* grade-sync jobs.

This schema remains portable to non-Azure PostgreSQL.

Require TLS.

Enable backups and point-in-time recovery appropriate to institutional policy.

## 35.4 Key Vault

Store:

* application session secret material;
* active/previous LTI private signing keys;
* identity resolver credentials;
* database credentials if managed DB identity is not used;
* HMAC card-fingerprint key.

Use Managed Identity to access Key Vault.

Azure Container Apps supports Key Vault secret references via managed identity and can automatically pick up newer unversioned secret values.

## 35.5 Container Registry

Store immutable application images in ACR.

Tag release images with the Git commit SHA.

Do not deploy `latest`.

Microsoft's Container Apps GitHub guidance likewise recommends unique image tags such as the commit SHA for separately built images.

---

# 36. Infrastructure as code

Everything required to create application infrastructure must exist under:

```text
infra/azure/
```

Use Bicep.

Parameters should include:

```text
environment name
Azure region
application hostname
PostgreSQL SKU
Container Apps sizing
min/max replicas
log retention
Key Vault name
custom domain settings
```

Environment-specific parameter files:

```text
dev
stage
prod
```

IaC MUST NOT contain secrets.

---

# 37. Environments

Maintain at least:

## Development

* mock identity resolver allowed;
* local PostgreSQL via Docker Compose;
* local application;
* Canvas test registration optionally available.

## Staging

* independent database;
* independent LTI registration;
* institution's Canvas test/beta environment where possible;
* production-like secrets and security headers.

## Production

* independent resources;
* production Canvas registration;
* branch/environment protection;
* production domain and TLS;
* backups;
* monitoring/alerts.

Never share database schemas/tables between stage and production.

---

# 38. Docker image

Use a multi-stage Docker build.

Conceptual stages:

```text
dependencies
build
runtime
```

Runtime image MUST:

* contain compiled application only;
* run as a non-root user;
* contain no development dependencies where avoidable;
* contain no `.git`;
* contain no `.env`;
* contain no signing key;
* expose one HTTP port;
* implement graceful SIGTERM shutdown.

Add:

```text
GET /health/live
GET /health/ready
```

`live` verifies process health.

`ready` verifies the application can serve requests and that critical startup configuration is valid.

Do not make readiness depend on Canvas itself being reachable.

---

# 39. Database migrations

Use versioned SQL/ORM migrations.

Rules:

* migrations are committed;
* migration ordering is deterministic;
* production application startup does not race multiple replicas to perform schema migrations;
* CI/CD runs migrations as a separate deployment step/job;
* schema changes should be backward-compatible during rolling deployment when feasible.

Take database backup/recovery characteristics into account before destructive migrations.

---

# 40. GitHub Actions CI

## 40.1 Pull request workflow

Every pull request shall run:

```text
checkout
install dependencies from lockfile
lint
typecheck
unit tests
LTI security tests
frontend tests
build
Docker build
dependency/security scan
```

A PR must not deploy to production.

Recommended browser tests include Chromium because WebHID support is Chromium-oriented.

Mock WebHID in automated browser tests.

Physical-reader testing remains a separate hardware validation step.

---

# 41. GitHub Actions deployment authentication

Use GitHub Actions OIDC federation to Azure.

Do not store a reusable Azure service-principal password or publish profile.

GitHub documents Azure OIDC specifically as a way for workflows to obtain short-lived Azure credentials without a long-lived Azure credential stored in GitHub. The workflow requires `id-token: write`.

Conceptual workflow permissions:

```yaml
permissions:
  contents: read
  id-token: write
```

Grant the deployment identity only the Azure permissions it requires.

Use separate federated identities or appropriately restricted federation conditions for production.

---

# 42. Deployment workflow

On merge to the primary branch:

1. run full CI;
2. authenticate to Azure using OIDC;
3. build container;
4. tag with Git commit SHA;
5. push to ACR;
6. validate Bicep;
7. deploy/update infrastructure;
8. run migrations;
9. deploy a new Container Apps revision;
10. wait for readiness;
11. smoke-test the new revision;
12. mark deployment successful.

Container Apps revisions are immutable snapshots, and in single-revision mode Azure keeps traffic on the old version until the replacement revision is ready.

Use that capability for rollback rather than rebuilding an old commit with a new image tag.

---

# 43. Production promotion

Recommended promotion model:

```text
main -> development automatically

version/tag or explicit workflow ->
staging

approved GitHub Environment ->
production
```

Use GitHub Environments for production.

Require:

* approved branches/tags;
* production reviewers if organizational policy permits;
* OIDC federation scoped to the production environment.

GitHub recommends environment protection rules when environments are used with OIDC.

---

# 44. Observability

Generate a request ID for every incoming request.

Structured logs should include safe fields such as:

```text
timestamp
level
requestId
environment
route
httpStatus
duration
institutionId
courseInternalId
attendanceSessionId
errorType
```

Avoid names/student IDs unless operationally required.

## Metrics

Track:

```text
LTI launch successes/failures
launch failure reason
NRPS latency/error rate
identity lookup latency/error rate
scan rate
unexpected scans
lookup errors
attendance session close count
AGS latency/error rate
pending grade jobs
failed grade jobs
database latency
HTTP 5xx rate
```

## Alerts

At minimum:

* elevated 5xx rate;
* database unavailable;
* sustained LTI launch failures;
* sustained card resolver failures;
* grade jobs failing/retrying beyond threshold;
* Key Vault access failure.

---

# 45. LTI authentication tests

These are release-blocking.

Write automated tests for:

1. valid launch;
2. missing state;
3. unknown state;
4. expired state;
5. reused state;
6. nonce mismatch;
7. nonce replay;
8. unknown issuer;
9. wrong client ID/audience;
10. invalid `azp`;
11. invalid signature;
12. unknown `kid` followed by successful JWKS refresh;
13. unknown `kid` after refresh;
14. expired JWT;
15. future-issued JWT;
16. unsupported signing algorithm;
17. wrong deployment ID;
18. wrong LTI version;
19. wrong message type;
20. missing context;
21. missing roles;
22. learner-only role;
23. tampered JWT;
24. target-link open-redirect attempt.

Do not consider LTI "done" until these tests exist.

---

# 46. Canvas integration tests

Use mocks/fixtures for routine CI and a real nonproduction Canvas environment for preproduction validation.

Test:

## NRPS

* multiple pages of roster results;
* active learner;
* inactive learner;
* instructor excluded;
* custom role;
* missing SIS ID;
* duplicate institutional IDs;
* changed roster;
* pagination failure;
* expired access token;
* 429 response.

## AGS

* line item doesn't exist;
* existing matching line item;
* score update;
* Canvas 429;
* transient Canvas 500;
* missing student;
* concluded course;
* stale score timestamp;
* retry after failure;
* repeated same grade calculation;
* session correction changes cumulative grade.

---

# 47. Scan-pipeline tests

Port the existing behavior into tests before significantly refactoring it.

Required cases:

* valid report creates one scan;
* invalid report ignored/logged;
* report without card payload ignored;
* duplicate within suppression window;
* duplicate after lookup success;
* duplicate after lookup failure retries lookup;
* two different cards scanned rapidly;
* second lookup resolves before first;
* first response does not overwrite second as "latest";
* record deleted while lookup pending;
* lookup timeout;
* identity not on roster;
* duplicate API submission with same `clientScanId`;
* network response lost then retried.

The current code is unusually careful about these race conditions; preserve that work rather than rediscovering it through classroom complaints.

---

# 48. Identity-resolver tests

Every resolver adapter must pass a shared contract suite:

```text
valid card
unknown card
timeout
connection failure
HTTP failure
invalid JSON
missing institutional ID
extra fields
leading-zero institutional ID
credential redaction
```

Mock resolver tests must be deterministic.

---

# 49. Accessibility

The application must be usable without depending exclusively on color or sound.

Requirements:

* keyboard-accessible controls;
* visible focus state;
* semantic labels;
* screen-reader-readable status changes;
* status text accompanying red/green state;
* sound alert optional;
* sufficient contrast;
* reader connection state exposed as text.

An "unexpected student" warning must remain meaningful with sound disabled and to a color-blind user.

---

# 50. User workflow

## First launch in a course

1. Instructor selects **Attendance** in Canvas.
2. Canvas opens a new tab.
3. LTI authentication completes.
4. App displays course name and current roster count.
5. Instructor selects **Start Attendance**.
6. App snapshots the roster.
7. Instructor selects **Connect Card Reader**.
8. Browser displays WebHID chooser.
9. Instructor selects reader.
10. Students scan.

## Each scan

Display prominently:

```text
student name
institutional ID if institution permits display
timestamp
Present / Unexpected / Lookup Error
```

If unexpected:

* large visible warning;
* audible tone if enabled.

If lookup fails:

* preserve failure;
* allow card to be rescanned;
* retry in the existing record rather than adding a duplicate.

## Finish

1. Instructor reviews list.
2. Instructor manually corrects exceptions if needed.
3. Instructor selects **Close Attendance**.
4. Application asks for confirmation.
5. Backend finalizes absences.
6. Grade synchronization begins.
7. UI shows grade synchronization status.

---

# 51. Standalone/development mode

Retain a non-LTI mode for development and demonstration.

It MAY support:

* uploaded CSV roster;
* mock card resolver;
* existing WebHID diagnostics;
* CSV export.

Do not make insecure browser-stored production identity-API credentials the default standalone architecture.

Production documentation should describe LTI mode as the supported institutional deployment.

---

# 52. Institution configuration

No Cedarville-specific value should be compiled into the application.

An institution configuration includes conceptually:

```yaml
institution:
  name: Example University
  timezone: America/New_York

canvas:
  registration: <database-managed registration>
  identityMatchField: lis_person_sourcedid

identityResolver:
  type: http
  timeoutMs: 5000
  method: GET
  endpointTemplate: <server-side configured value>
  institutionalIdField: student.id
  givenNameField: student.givenName
  familyNameField: student.familyName
  emailField: student.email

grading:
  lineItemLabel: Attendance
  presentPoints: 1
  latePoints: 1
  absentPoints: 0
  excusedExcluded: true
```

Secrets referenced by that configuration live in the secret store, not in the YAML/database document itself.

---

# 53. Cedarville migration

For the original deployment, migrate the existing implementation as follows.

## Existing WebHID

Preserve:

```text
hid-reader.js
omnikey-parser.js
device diagnostics
known-device reconnect
Custom Report parsing
```

The current repository already uses HID Global's vendor identifier and supports reconnecting previously-authorized WebHID devices.

## Existing card lookup

Move the current ProxID lookup semantics into the server-side HTTP identity resolver.

Map the existing institutional student identifier to:

```text
IdentityResolution.institutionalId
```

Do not expose the current resolver API key or key name to the browser.

## Existing roster

In normal LTI mode:

```text
CSV roster -> NRPS roster
```

Keep CSV parser for fallback/development.

## Existing local persistence

In LTI mode:

```text
localStorage attendance -> PostgreSQL attendance
```

Retain only safe preferences locally.

## Existing CSV

Retain export capability.

Server-side generation is preferred in LTI mode so exports reflect authoritative attendance, including manual corrections and absences.

---

# 54. Implementation phases

## Phase 0 — Baseline and tests

Before structural changes:

* add Node project tooling;
* add linting;
* create unit-test harness;
* add tests around OMNIKEY parser;
* add tests around ScanPipeline;
* add tests around roster parsing;
* preserve existing browser app behavior.

**Exit criterion:** current standalone scanner still works.

---

## Phase 1 — Repository restructuring

Move browser sources into `web/`.

Create `server/`.

Create one local development command that starts:

```text
PostgreSQL
backend
frontend
```

Use Docker Compose for local PostgreSQL.

**Exit criterion:** existing frontend is served through the new backend with no card behavior regression.

---

## Phase 2 — Server-side identity resolver

Implement:

```text
IdentityResolver interface
MockIdentityResolver
HttpIdentityResolver
```

Replace browser card-service requests with same-origin backend scan requests.

Remove production credentials UI.

**Exit criterion:** scanner works through backend and no resolver secret reaches browser JavaScript.

---

## Phase 3 — LTI authentication

Implement:

```text
/lti/login
/lti/launch
/lti/jwks
OIDC transaction storage
launch validation
application sessions
role authorization
```

Add the full security test matrix.

**Exit criterion:** the full §45 security test matrix passes against an in-process mock Canvas
platform — valid instructor launches produce a session, and every malformed/replayed/unauthorized
launch is rejected before one is created.

Registering the tool in a real Canvas instance and confirming an instructor launch end-to-end is
**not** part of this phase: it requires a publicly reachable HTTPS deployment, which does not exist
until Phase 7. That real-Canvas registration and verification (including checking the role-claim
URIs against an actual launch payload) is a Phase 7 post-deployment step — see
`docs/canvas-installation.md`.

---

## Phase 4 — NRPS

Implement Canvas token acquisition and roster retrieval.

Replace uploaded roster as the primary workflow.

Add identity matching configuration.

**Exit criterion:** instructor launches from a course and sees the active Canvas learner roster without uploading a file.

---

## Phase 5 — Persistent attendance

Implement:

```text
attendance sessions
roster snapshots
scan persistence
manual corrections
session close/reopen
audit events
CSV export
```

**Exit criterion:** closing/reopening the browser does not lose server-accepted attendance.

---

## Phase 6 — AGS grading

Implement:

```text
cumulative line item
grade calculation
score submission
grade outbox
retry worker
status UI
```

**Exit criterion:** closing attendance updates the expected Canvas Gradebook column.

---

## Phase 7 — Infrastructure and CI/CD

Implement:

```text
Dockerfile
Bicep
Azure Container Apps
PostgreSQL
Key Vault
ACR
GitHub Actions OIDC deployment
stage/prod environments
health checks
monitoring
```

Once a public HTTPS deployment exists, perform the real-Canvas registration and launch verification
that earlier phases could not: register the tool in Canvas (Admin → Apps, JSON configuration — the
scopes and `windowTarget: _blank` are not settable through the form), install it in a test course,
seed the registration, then confirm an instructor launch opens the scanner in a new tab and a
learner-role launch returns HTTP 403. Verify `AUTHORIZED_INSTRUCTOR_ROLE_URIS` against a real launch
payload at this point. Full steps: `docs/canvas-installation.md`.

**Exit criterion:** a tagged/approved release deploys without any long-lived Azure deployment
password in GitHub, and an instructor LTI launch from a real Canvas course succeeds against the
deployed instance while a learner-role launch is refused.

---

## Phase 8 — Hardening

Perform:

* dependency review;
* CSP testing;
* CSRF testing;
* tenant-isolation testing;
* rate-limit testing;
* resolver redaction testing;
* key rotation drill;
* database restore drill;
* Canvas token/key rotation tests;
* browser/hardware validation.

---

# 55. Definition of done

The project is production-ready when all of the following are true:

* [ ] Instructor can launch Attendance from Canvas Course Navigation.
* [ ] Scanner opens top-level/new-tab.
* [ ] Invalid LTI launches are rejected.
* [ ] LTI state and nonce are replay-resistant.
* [ ] Learners cannot access instructor functionality.
* [ ] Canvas roster loads through NRPS.
* [ ] No Canvas REST user token is required.
* [ ] Card resolver credentials never reach the browser.
* [ ] Card API no longer requires frontend CORS access.
* [ ] Existing OMNIKEY reader works.
* [ ] Rapid scans are handled correctly.
* [ ] Duplicate scans are suppressed/idempotent.
* [ ] Lookup failures remain visible and retryable.
* [ ] Unexpected students are clearly flagged.
* [ ] Attendance is persisted in PostgreSQL.
* [ ] Instructor can correct attendance.
* [ ] Changes are audited.
* [ ] Closing a session marks unscanned eligible students absent.
* [ ] Attendance grade is calculated according to institution policy.
* [ ] A single cumulative Canvas Gradebook line item is created/reused.
* [ ] Grades synchronize via AGS.
* [ ] Failed grade synchronization is durable and retryable.
* [ ] Raw card codes are not persisted by default.
* [ ] Secrets are stored server-side in Key Vault/reference secret store.
* [ ] Tool private signing key is absent from Git and browser assets.
* [ ] `/lti/jwks` supports key rotation.
* [ ] Security headers are enabled.
* [ ] CI includes tests, lint, typecheck, and build.
* [ ] Azure deployment uses GitHub OIDC.
* [ ] Production image is identified by immutable Git SHA.
* [ ] Infrastructure is reproducible from IaC.
* [ ] Application documentation contains no institution-specific assumption presented as universal.
* [ ] An institution can configure a different card resolver without modifying attendance-domain code.

---

# 56. Implementation-agent instructions

When implementing this specification:

1. **Preserve existing working behavior first.**
2. Add tests before materially changing `scan-pipeline.js` or OMNIKEY parsing.
3. Do not rewrite the frontend in a framework unless a concrete requirement demands it.
4. Keep Canvas-specific code behind an LTI/Canvas service boundary.
5. Keep card-system-specific code behind `IdentityResolver`.
6. Keep cloud-specific code under `infra/`.
7. Never place credentials in browser code.
8. Never hand-roll cryptographic algorithms.
9. Treat every Canvas JWT claim as untrusted until signature and standard claim validation are complete.
10. Treat every browser-supplied course/user ID as untrusted; derive authorization scope from the authenticated application session.
11. Write tenant isolation into database queries rather than relying on UI state.
12. Keep raw card identifiers out of durable logs and storage wherever possible.
13. Prefer straightforward code and explicit validation over architectural cleverness.
14. Maintain a working mock environment so development does not require Canvas or physical card infrastructure.
15. Update the documentation as each phase is completed.

---

# 57. Documentation deliverables

The completed repository shall contain:

## `README.md`

* project overview;
* screenshots/basic workflow;
* browser requirements;
* development quick start;
* links to detailed docs.

## `docs/architecture.md`

* component diagram;
* request flows;
* storage model;
* adapter model.

## `docs/canvas-installation.md`

* LTI tool registration (Admin → Apps, JSON configuration);
* required scopes;
* course-navigation placement;
* new-tab configuration (`windowTarget`, JSON-only);
* privacy-level choices;
* client/deployment ID entry;
* production/beta/test differences;
* note that this is a post-deployment step (needs a public HTTPS instance).

## `docs/security.md`

* LTI validation;
* key storage/rotation;
* secret management;
* CSRF;
* CSP;
* card privacy;
* threat model.

## `docs/identity-resolvers.md`

* resolver contract;
* mock configuration;
* generic HTTP configuration;
* how to implement a new adapter.

## `docs/development.md`

* local PostgreSQL;
* mock LTI fixtures;
* mock identity service;
* tests;
* local HTTPS/WebHID testing.

## `docs/operations.md`

* deployments;
* migrations;
* key rotation;
* grade retry;
* monitoring;
* backup/restore;
* incident response.

---

# 58. Authoritative technical references

Implementation should be checked against the current specifications and vendor documentation rather than relying exclusively on examples in this document.

* Instructure's LTI Launch Overview defines Canvas's OIDC login initiation, browser redirect, signed `id_token`, state validation, environment-specific issuers, and Platform Storage behavior. [Canvas LTI Launch Overview](https://developerdocs.instructure.com/services/canvas/external-tools/lti/file.lti_launch_overview?utm_source=chatgpt.com)
* Instructure's LTI configuration documentation defines Developer Key fields, service scopes, public JWKS configuration, and placements. [Canvas LTI configuration documentation](https://developerdocs.instructure.com/services/canvas/external-tools/lti/file.lti_dev_key_config?utm_source=chatgpt.com)
* Canvas's NRPS documentation defines membership fields, required scope, privacy-dependent fields, and LTI user/SIS identifiers. [Canvas Names and Role documentation](https://developerdocs.instructure.com/services/canvas/resources/names_and_role?utm_source=chatgpt.com)
* Canvas's provisioning guide explains using NRPS without separate Canvas REST authorization. [Canvas provisioning documentation](https://developerdocs.instructure.com/services/canvas/external-tools/lti/file.provisioning?utm_source=chatgpt.com)
* Canvas's AGS documentation explains line-item creation and grade passback without student launches. [Canvas grading documentation](https://developerdocs.instructure.com/services/canvas/external-tools/lti/file.assignment_tools?utm_source=chatgpt.com)
* Canvas's Line Items API defines line-item fields and creation behavior. [Canvas Line Items documentation](https://developerdocs.instructure.com/services/canvas/resources/line_items?utm_source=chatgpt.com)
* Canvas's Score API defines grade submission fields and timestamp behavior. [Canvas Score documentation](https://developerdocs.instructure.com/services/canvas/resources/score?utm_source=chatgpt.com)
* Canvas's OAuth documentation defines its LTI Advantage Client Credentials/JWT assertion flow. [Canvas OAuth2 endpoint documentation](https://developerdocs.instructure.com/services/canvas/oauth2/file.oauth_endpoints?utm_source=chatgpt.com)
* 1EdTech's LTI implementation guidance covers issuer/audience validation, private-key management, RSA key requirements, and JWKS rotation. [1EdTech LTI Advantage Implementation Guide](https://standards.1edtech.org/lti/guides/implementation_guide/implementation-guide?utm_source=chatgpt.com)
* 1EdTech's migration guide describes the registration/deployment identity model. [1EdTech LTI Migration Guide](https://standards.1edtech.org/lti/guides/migration/migration-guide?utm_source=chatgpt.com)
* MDN documents WebHID's HTTPS/user-activation requirements and HID Permissions Policy. [MDN WebHID requestDevice documentation](https://developer.mozilla.org/en-US/docs/Web/API/HID/requestDevice?utm_source=chatgpt.com)
* Microsoft documents Container Apps Key Vault references through managed identity. [Azure Container Apps secret management](https://learn.microsoft.com/en-us/azure/container-apps/manage-secrets?utm_source=chatgpt.com)
* GitHub documents Azure deployment through workload identity federation/OIDC instead of long-lived deployment credentials. [GitHub Actions OIDC for Azure](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-azure?utm_source=chatgpt.com)

---

# 59. Final architecture decision

The reference implementation shall be:

**one Git repository containing the existing WebHID frontend, a small TypeScript LTI/backend service, PostgreSQL persistence, Docker packaging, Bicep infrastructure, and GitHub Actions CI/CD.**

The frontend remains responsible for the one job that genuinely belongs in the browser: interacting with the physical HID reader and providing immediate instructor feedback.

The backend becomes responsible for everything requiring trust:

```text
Canvas authentication
Canvas authorization
Canvas service tokens
LTI signing keys
institutional API credentials
roster retrieval
identity matching
authoritative attendance storage
audit history
grade calculation
grade synchronization
```

That boundary should remain the central architectural rule of the project.

