// server/src/security/same-origin.ts
//
// Backlog item 6.1: before the grade worker sends a bearer-token AGS Score POST to a line-item URL
// that Canvas returned in a response body, confirm that URL is on the SAME ORIGIN as the
// launch-persisted courses.ags_lineitems_url (the SSRF trust anchor -- spec §31.7). A compromised
// or buggy Canvas-shaped response could otherwise redirect a valid AGS bearer token to an
// attacker origin.

export function assertSameOrigin(candidateUrl: string, anchorUrl: string): void {
  let candidate: URL;
  let anchor: URL;
  try {
    candidate = new URL(candidateUrl);
    anchor = new URL(anchorUrl);
  } catch {
    throw new Error('same-origin:unparseable');
  }
  if (candidate.origin !== anchor.origin) {
    throw new Error('same-origin:mismatch');
  }
}
