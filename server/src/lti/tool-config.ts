// server/src/lti/tool-config.ts
//
// Builds the Canvas LTI 1.3 tool-configuration body served at GET /lti/config.json, which is what
// an operator registers in Canvas (Developer Keys -> + LTI Key -> Method: Enter URL).
//
// Why this is code and not a JSON block in the install doc: every URL here has to agree with
// APP_BASE_URL, and the `scopes` array has to reproduce scopes.ts character-for-character. A
// hand-substituted template in Markdown can satisfy neither reliably -- the previous doc's
// `https://<APP_BASE_URL>/lti/login` placeholder produced a doubled scheme when filled in as
// instructed, and nothing tested it. Generating the body means Canvas re-fetches the current truth
// on every refresh.
//
// Pure: no Fastify, no database, no I/O. See routes/lti-config.ts for the HTTP wrapper.
import {
  NRPS_MEMBERSHIP_READONLY_SCOPE,
  AGS_LINEITEM_SCOPE,
  AGS_SCORE_SCOPE,
} from './scopes.js';

// The official tool name. Drives every `title` and `text` field in the generated registration: the
// app title in Canvas and the course-navigation link label instructors click. Overridable per
// deployment via LTI_TOOL_TITLE; this constant is the single definition of the default, so
// config/env.ts leaves LTI_TOOL_TITLE optional rather than restating it.
export const DEFAULT_TOOL_TITLE = 'Scanttendance';

const TOOL_DESCRIPTION = 'Classroom attendance via a browser-connected HID card reader';

// The scanner page, NOT /lti/launch. Canvas copies this into the launch's `target_link_uri` and
// /lti/launch 303-redirects to it on success, so naming the launch endpoint here would redirect it
// to itself. Whatever this resolves to must also appear in ALLOWED_TARGET_LINK_URIS -- app.ts warns
// at boot when it does not.
const TARGET_LINK_PATH = '/index.html';

export interface CanvasPlacement {
  placement: string;
  message_type: string;
  target_link_uri: string;
  text: string;
  windowTarget: string;
  default: string;
  visibility: string;
}

export interface CanvasExtension {
  platform: string;
  domain: string;
  privacy_level: string;
  settings: {
    text: string;
    placements: CanvasPlacement[];
  };
}

export interface CanvasToolConfig {
  title: string;
  description: string;
  oidc_initiation_url: string;
  target_link_uri: string;
  public_jwk_url: string;
  redirect_uris: string[];
  scopes: string[];
  extensions: CanvasExtension[];
}

// `new URL(path, base)` rather than concatenation: APP_BASE_URL is already normalized to a bare
// origin (config/env.ts), and this makes a doubled scheme or a `//` join structurally impossible
// rather than merely currently-absent.
function at(appBaseUrl: string, path: string): string {
  return new URL(path, appBaseUrl).toString();
}

export function toolTargetLinkUri(appBaseUrl: string): string {
  return at(appBaseUrl, TARGET_LINK_PATH);
}

export function buildCanvasToolConfig(
  appBaseUrl: string,
  title: string = DEFAULT_TOOL_TITLE,
): CanvasToolConfig {
  const targetLinkUri = toolTargetLinkUri(appBaseUrl);

  return {
    title,
    description: TOOL_DESCRIPTION,
    oidc_initiation_url: at(appBaseUrl, '/lti/login'),
    target_link_uri: targetLinkUri,
    // This app publishes its own rotating public keys, so Canvas must fetch them by URL rather than
    // cache a static `public_jwk`. Rotation via the admin page then needs no Canvas edit, only a
    // JWKS re-fetch.
    public_jwk_url: at(appBaseUrl, '/lti/jwks'),
    // Where Canvas form-POSTs the signed id_token.
    redirect_uris: [at(appBaseUrl, '/lti/launch')],
    // Spec §10: NRPS context-membership read, AGS line items read/write, AGS scores write -- and
    // deliberately NOT the AGS Result read scope. Imported, never re-typed.
    scopes: [NRPS_MEMBERSHIP_READONLY_SCOPE, AGS_LINEITEM_SCOPE, AGS_SCORE_SCOPE],
    extensions: [
      {
        platform: 'canvas.instructure.com',
        // A bare host (with port, if any) -- not an origin. Canvas rejects a scheme here.
        domain: new URL(appBaseUrl).host,
        // Spec §10.2: NRPS then returns names and lis_person_sourcedid, but not email.
        privacy_level: 'name_only',
        settings: {
          text: title,
          placements: [
            {
              placement: 'course_navigation',
              message_type: 'LtiResourceLinkRequest',
              target_link_uri: targetLinkUri,
              text: title,
              // Required (spec §8). WebHID's Permissions Policy defaults to `self`, so a
              // cross-origin Canvas iframe never receives HID capability -- the scanner has to open
              // top-level or the card reader cannot be connected at all. This key is the original
              // reason the whole registration had to be JSON: the Canvas Apps form has no field for
              // it.
              windowTarget: '_blank',
              default: 'enabled',
              // Shows the course-nav link to admins and instructors, not learners. UI convenience
              // only -- /lti/launch validates the LTI role claim independently (spec §10.1).
              visibility: 'admins',
            },
          ],
        },
      },
    ],
  };
}
