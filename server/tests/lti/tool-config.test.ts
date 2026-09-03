import { describe, it, expect } from 'vitest';
import {
  buildCanvasToolConfig,
  toolTargetLinkUri,
  DEFAULT_TOOL_TITLE,
} from '../../src/lti/tool-config.js';
import {
  NRPS_MEMBERSHIP_READONLY_SCOPE,
  AGS_LINEITEM_SCOPE,
  AGS_SCORE_SCOPE,
} from '../../src/lti/scopes.js';

const BASE = 'https://attendance.example.edu';

describe('buildCanvasToolConfig', () => {
  it('derives every URL from the given origin with exactly one scheme', () => {
    const config = buildCanvasToolConfig(BASE);

    expect(config.oidc_initiation_url).toBe(`${BASE}/lti/login`);
    expect(config.target_link_uri).toBe(`${BASE}/index.html`);
    expect(config.public_jwk_url).toBe(`${BASE}/lti/jwks`);
    expect(config.redirect_uris).toEqual([`${BASE}/lti/launch`]);

    // The bug this endpoint exists to kill: a doubled scheme from string concatenation.
    for (const url of [
      config.oidc_initiation_url,
      config.target_link_uri,
      config.public_jwk_url,
      ...config.redirect_uris,
    ]) {
      expect(url.match(/https?:\/\//g)).toHaveLength(1);
    }
  });

  it('handles a port-bearing origin', () => {
    const config = buildCanvasToolConfig('http://localhost:3000');

    expect(config.oidc_initiation_url).toBe('http://localhost:3000/lti/login');
    expect(config.extensions[0].domain).toBe('localhost:3000');
  });

  it('requests exactly the three scopes named in scopes.ts', () => {
    // Regression guard for scopes.ts's "reproduce verbatim, never paraphrase" contract: the
    // registration must be generated from those constants, never re-typed. Also asserts the app
    // does NOT request the AGS Result read scope (spec §10).
    expect(buildCanvasToolConfig(BASE).scopes).toEqual([
      NRPS_MEMBERSHIP_READONLY_SCOPE,
      AGS_LINEITEM_SCOPE,
      AGS_SCORE_SCOPE,
    ]);
  });

  it('sets domain to a bare host, with no scheme and no path', () => {
    const domain = buildCanvasToolConfig(BASE).extensions[0].domain;

    expect(domain).toBe('attendance.example.edu');
    expect(domain).not.toContain('://');
    expect(domain).not.toContain('/');
  });

  it('opens the course-navigation placement in a new top-level window', () => {
    // WebHID's Permissions Policy defaults to `self`, so a cross-origin Canvas iframe never gets
    // HID capability -- the scanner has to escape the iframe (spec §8).
    const placement = buildCanvasToolConfig(BASE).extensions[0].settings.placements[0];

    expect(placement.placement).toBe('course_navigation');
    expect(placement.windowTarget).toBe('_blank');
    expect(placement.message_type).toBe('LtiResourceLinkRequest');
  });

  it('points target_link_uri at the scanner page, not the launch endpoint', () => {
    // /lti/launch 303-redirects to target_link_uri; naming itself there would loop.
    const config = buildCanvasToolConfig(BASE);

    expect(config.target_link_uri).not.toContain('/lti/launch');
    expect(config.extensions[0].settings.placements[0].target_link_uri).toBe(config.target_link_uri);
  });

  it('keeps privacy_level at name_only so NRPS omits email', () => {
    expect(buildCanvasToolConfig(BASE).extensions[0].privacy_level).toBe('name_only');
  });
});

describe('tool title', () => {
  it('defaults to Scanttendance in every title and text field', () => {
    const config = buildCanvasToolConfig(BASE);

    expect(DEFAULT_TOOL_TITLE).toBe('Scanttendance');
    expect(config.title).toBe('Scanttendance');
    expect(config.extensions[0].settings.text).toBe('Scanttendance');
    expect(config.extensions[0].settings.placements[0].text).toBe('Scanttendance');
  });

  it('applies an override to every title and text field at once', () => {
    // One value drives all three, so a deployment cannot end up with the app named one thing and
    // its course-navigation link another.
    const config = buildCanvasToolConfig(BASE, 'Class Check-In');

    expect(config.title).toBe('Class Check-In');
    expect(config.extensions[0].settings.text).toBe('Class Check-In');
    expect(config.extensions[0].settings.placements[0].text).toBe('Class Check-In');
  });

  it('leaves the rest of the registration untouched when the title changes', () => {
    const renamed = buildCanvasToolConfig(BASE, 'Class Check-In');
    const dflt = buildCanvasToolConfig(BASE);

    expect(renamed.scopes).toEqual(dflt.scopes);
    expect(renamed.target_link_uri).toBe(dflt.target_link_uri);
    expect(renamed.oidc_initiation_url).toBe(dflt.oidc_initiation_url);
    expect(renamed.extensions[0].domain).toBe(dflt.extensions[0].domain);
  });
});

describe('toolTargetLinkUri', () => {
  it('matches the target_link_uri the config advertises', () => {
    expect(toolTargetLinkUri(BASE)).toBe(buildCanvasToolConfig(BASE).target_link_uri);
  });
});
