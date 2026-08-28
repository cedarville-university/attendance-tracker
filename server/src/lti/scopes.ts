//
// Named IMS LTI Advantage scope URIs. These are the literal standardized 1EdTech URIs that Canvas's
// Developer Key UI populates for each capability -- reproduce them verbatim, never paraphrase.
// Only the NRPS membership read scope is needed this phase; AGS scopes land in Phase 6 with the code
// that uses them.

export const NRPS_MEMBERSHIP_READONLY_SCOPE =
  'https://purl.imsglobal.org/spec/lti-nrps/scope/contextmembership.readonly';

// AGS line-item read/write and score write (spec §10 "Canvas registration" — the capability list
// "AGS line items: read/write" / "AGS scores: write"). These are the literal 1EdTech URIs Canvas's
// Developer Key UI populates and `docs/canvas-installation.md` lists verbatim; reproduce them
// character-for-character, never paraphrase. The app deliberately does NOT request the AGS Result
// read scope (spec §10: "The application does not initially require the AGS Result read scope").
export const AGS_LINEITEM_SCOPE = 'https://purl.imsglobal.org/spec/lti-ags/scope/lineitem';
export const AGS_SCORE_SCOPE = 'https://purl.imsglobal.org/spec/lti-ags/scope/score';
