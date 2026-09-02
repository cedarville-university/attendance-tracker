//
// Named IMS LTI Advantage scope URIs. These are the literal standardized 1EdTech URIs that Canvas's
// Developer Key UI populates for each capability -- reproduce them verbatim, never paraphrase.
// Only the NRPS membership read scope is needed this phase; AGS scopes land in Phase 6 with the code
// that uses them.

export const NRPS_MEMBERSHIP_READONLY_SCOPE =
  'https://purl.imsglobal.org/spec/lti-nrps/scope/contextmembership.readonly';

// AGS line-item read/write and score write (spec §10 "Canvas registration" — the capability list
// "AGS line items: read/write" / "AGS scores: write"). These are the literal 1EdTech URIs Canvas's
// Developer Key UI populates; reproduce them character-for-character, never paraphrase. The app
// deliberately does NOT request the AGS Result read scope (spec §10: "The application does not
// initially require the AGS Result read scope").
//
// This file is the single source of truth. `lti/tool-config.ts` imports these three constants into
// the registration served at GET /lti/config.json, so the scope list an operator installs can no
// longer drift from the one the app requests; `tests/lti/tool-config.test.ts` asserts that identity.
export const AGS_LINEITEM_SCOPE = 'https://purl.imsglobal.org/spec/lti-ags/scope/lineitem';
export const AGS_SCORE_SCOPE = 'https://purl.imsglobal.org/spec/lti-ags/scope/score';
