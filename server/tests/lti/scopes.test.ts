import { describe, it, expect } from 'vitest';
import { NRPS_MEMBERSHIP_READONLY_SCOPE } from '../../src/lti/scopes.js';

describe('LTI Advantage scope constants', () => {
  it('exposes the exact 1EdTech-documented NRPS membership read scope URI', () => {
    expect(NRPS_MEMBERSHIP_READONLY_SCOPE).toBe(
      'https://purl.imsglobal.org/spec/lti-nrps/scope/contextmembership.readonly',
    );
  });
});
