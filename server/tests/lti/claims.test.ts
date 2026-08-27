import { describe, it, expect } from 'vitest';
import { validateLtiClaims } from '../../src/lti/claims.js';

function validClaims(overrides: Record<string, unknown> = {}) {
  return {
    iss: 'https://canvas.test',
    aud: 'client-1',
    sub: 'user-1',
    exp: 9999999999,
    iat: 1000000000,
    nonce: 'nonce-value',
    'https://purl.imsglobal.org/spec/lti/claim/version': '1.3.0',
    'https://purl.imsglobal.org/spec/lti/claim/message_type': 'LtiResourceLinkRequest',
    'https://purl.imsglobal.org/spec/lti/claim/deployment_id': 'deploy-1',
    'https://purl.imsglobal.org/spec/lti/claim/context': { id: 'course-1' },
    'https://purl.imsglobal.org/spec/lti/claim/roles': ['http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor'],
    ...overrides,
  };
}

describe('validateLtiClaims', () => {
  it('accepts a fully valid claim set', () => {
    const result = validateLtiClaims(validClaims());
    expect(result.ok).toBe(true);
  });

  it('§45 case 18: rejects the wrong LTI version', () => {
    const result = validateLtiClaims(validClaims({ 'https://purl.imsglobal.org/spec/lti/claim/version': '1.1.0' }));
    expect(result).toEqual({ ok: false, reason: 'wrong_version' });
  });

  it('§45 case 19: rejects the wrong message type', () => {
    const result = validateLtiClaims(validClaims({ 'https://purl.imsglobal.org/spec/lti/claim/message_type': 'LtiDeepLinkingRequest' }));
    expect(result).toEqual({ ok: false, reason: 'wrong_message_type' });
  });

  it('§45 case 20: rejects a missing context claim', () => {
    const { 'https://purl.imsglobal.org/spec/lti/claim/context': _context, ...withoutContext } = validClaims();
    const result = validateLtiClaims(withoutContext);
    expect(result).toEqual({ ok: false, reason: 'missing_context' });
  });

  it('§45 case 21: rejects a missing roles claim', () => {
    const { 'https://purl.imsglobal.org/spec/lti/claim/roles': _roles, ...withoutRoles } = validClaims();
    const result = validateLtiClaims(withoutRoles);
    expect(result).toEqual({ ok: false, reason: 'missing_roles' });
  });

  it('rejects an empty roles array as missing_roles', () => {
    const result = validateLtiClaims(validClaims({ 'https://purl.imsglobal.org/spec/lti/claim/roles': [] }));
    expect(result).toEqual({ ok: false, reason: 'missing_roles' });
  });
});
