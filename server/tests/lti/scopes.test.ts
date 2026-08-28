import { describe, it, expect } from 'vitest';
import {
  NRPS_MEMBERSHIP_READONLY_SCOPE,
  AGS_LINEITEM_SCOPE,
  AGS_SCORE_SCOPE,
} from '../../src/lti/scopes.js';

describe('LTI Advantage scope constants', () => {
  it('exposes the exact 1EdTech-documented NRPS membership read scope URI', () => {
    expect(NRPS_MEMBERSHIP_READONLY_SCOPE).toBe(
      'https://purl.imsglobal.org/spec/lti-nrps/scope/contextmembership.readonly',
    );
  });

  it('exposes the character-exact AGS line-item and score scope URIs', () => {
    expect(AGS_LINEITEM_SCOPE).toBe('https://purl.imsglobal.org/spec/lti-ags/scope/lineitem');
    expect(AGS_SCORE_SCOPE).toBe('https://purl.imsglobal.org/spec/lti-ags/scope/score');
  });

  it('does not request the AGS Result read scope (spec §10 "The application does not initially require the AGS Result read scope")', () => {
    const all = [AGS_LINEITEM_SCOPE, AGS_SCORE_SCOPE];
    expect(all.some((s) => s.includes('result'))).toBe(false);
  });
});
