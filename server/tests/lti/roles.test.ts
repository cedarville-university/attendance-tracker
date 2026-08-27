// server/tests/lti/roles.test.ts
import { describe, it, expect } from 'vitest';
import { authorizeInstructorRole } from '../../src/lti/roles.js';

describe('authorizeInstructorRole', () => {
  it('authorizes the standard 1EdTech Instructor context-role URI', () => {
    expect(authorizeInstructorRole(['http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor'])).toBe(true);
  });

  it('authorizes the standard 1EdTech Administrator context-role URI', () => {
    expect(authorizeInstructorRole(['http://purl.imsglobal.org/vocab/lis/v2/membership#Administrator'])).toBe(true);
  });

  it('§45 case 22: rejects a learner-only role set', () => {
    expect(authorizeInstructorRole(['http://purl.imsglobal.org/vocab/lis/v2/membership#Learner'])).toBe(false);
  });

  it('rejects an empty role list', () => {
    expect(authorizeInstructorRole([])).toBe(false);
  });

  it('never authorizes via substring match -- a role that merely contains "Instructor" is rejected', () => {
    expect(authorizeInstructorRole(['NotAnInstructorRoleAtAllXYZ'])).toBe(false);
    expect(authorizeInstructorRole(['http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor-fake'])).toBe(false);
  });

  it('authorizes when at least one role in a mixed list matches', () => {
    expect(
      authorizeInstructorRole([
        'http://purl.imsglobal.org/vocab/lis/v2/membership#Learner',
        'http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor',
      ]),
    ).toBe(true);
  });
});
