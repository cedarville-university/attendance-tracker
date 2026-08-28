import { describe, it, expect } from 'vitest';
import {
  resolveInstitutionRosterConfig,
  resolveInstitutionalId,
  isEligibleForAttendance,
  type NrpsRawMember,
} from '../../src/lti/roster-config.js';

describe('resolveInstitutionRosterConfig', () => {
  it('defaults rosterLearnerRoles to ["Learner"] when the institution row has none (spec §18.2)', () => {
    const config = resolveInstitutionRosterConfig({
      canvasIdentityMatchField: 'lis_person_sourcedid',
      identityMatchEmailEnabled: false,
      rosterLearnerRoles: [],
    });
    expect(config.rosterLearnerRoles).toEqual(['Learner']);
  });

  it('passes through a configured custom learner-role list', () => {
    const config = resolveInstitutionRosterConfig({
      canvasIdentityMatchField: 'lis_person_sourcedid',
      identityMatchEmailEnabled: true,
      rosterLearnerRoles: ['Learner', 'ProxyLearner'],
    });
    expect(config).toEqual({
      canvasIdentityMatchField: 'lis_person_sourcedid',
      identityMatchEmailEnabled: true,
      rosterLearnerRoles: ['Learner', 'ProxyLearner'],
    });
  });
});

describe('resolveInstitutionalId', () => {
  const baseConfig = {
    canvasIdentityMatchField: 'lis_person_sourcedid',
    identityMatchEmailEnabled: false,
    rosterLearnerRoles: ['Learner'],
  };

  it('reads the configured field and trims it', () => {
    const raw: NrpsRawMember = { user_id: 'u1', status: 'Active', roles: [], lis_person_sourcedid: '  001234  ' };
    expect(resolveInstitutionalId(raw, baseConfig)).toBe('001234');
  });

  it('preserves leading zeroes rather than coercing to a number', () => {
    const raw: NrpsRawMember = { user_id: 'u1', status: 'Active', roles: [], lis_person_sourcedid: '0009' };
    expect(resolveInstitutionalId(raw, baseConfig)).toBe('0009');
  });

  it('returns null when the configured field is missing (missing SIS ID)', () => {
    const raw: NrpsRawMember = { user_id: 'u1', status: 'Active', roles: [] };
    expect(resolveInstitutionalId(raw, baseConfig)).toBeNull();
  });

  it('returns null for an email match field when email matching is not enabled', () => {
    const raw: NrpsRawMember = { user_id: 'u1', status: 'Active', roles: [], email: 'student@example.edu' };
    const config = { ...baseConfig, canvasIdentityMatchField: 'email', identityMatchEmailEnabled: false };
    expect(resolveInstitutionalId(raw, config)).toBeNull();
  });

  it('reads email when email matching is enabled', () => {
    const raw: NrpsRawMember = { user_id: 'u1', status: 'Active', roles: [], email: 'student@example.edu' };
    const config = { ...baseConfig, canvasIdentityMatchField: 'email', identityMatchEmailEnabled: true };
    expect(resolveInstitutionalId(raw, config)).toBe('student@example.edu');
  });
});

describe('isEligibleForAttendance', () => {
  const learnerRoleUri = 'http://purl.imsglobal.org/vocab/lis/v2/membership#Learner';
  const instructorRoleUri = 'http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor';

  it('is true for an active learner', () => {
    expect(isEligibleForAttendance('Active', [learnerRoleUri], ['Learner'])).toBe(true);
  });
  it('is false for an inactive learner', () => {
    expect(isEligibleForAttendance('Inactive', [learnerRoleUri], ['Learner'])).toBe(false);
  });
  it('is false for an active instructor', () => {
    expect(isEligibleForAttendance('Active', [instructorRoleUri], ['Learner'])).toBe(false);
  });
  it('is true for a custom configured learner-role fragment', () => {
    const customRoleUri = 'http://purl.imsglobal.org/vocab/lis/v2/membership#ProxyLearner';
    expect(isEligibleForAttendance('Active', [customRoleUri], ['Learner', 'ProxyLearner'])).toBe(true);
  });
});
