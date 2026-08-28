import { describe, it, expect } from 'vitest';
import { DEFAULT_GRADING_POLICY, scoreContribution } from '../../src/attendance/grade-policy.js';

describe('DEFAULT_GRADING_POLICY', () => {
  it('is present=1, absent=0, excused excluded from the denominator (spec §27.2)', () => {
    expect(DEFAULT_GRADING_POLICY).toEqual({ presentPoints: 1, absentPoints: 0, excusedExcluded: true });
  });
});

describe('scoreContribution', () => {
  const p = DEFAULT_GRADING_POLICY;

  it('present -> earns presentPoints and counts toward the denominator', () => {
    expect(scoreContribution('present', p)).toEqual({ earned: 1, inDenominator: true });
  });

  it('absent -> earns absentPoints and counts toward the denominator', () => {
    expect(scoreContribution('absent', p)).toEqual({ earned: 0, inDenominator: true });
  });

  it('excused -> excluded from the denominator when excusedExcluded is true', () => {
    expect(scoreContribution('excused', p)).toEqual({ earned: 0, inDenominator: false });
  });

  it('excused -> treated like absent when excusedExcluded is false', () => {
    expect(scoreContribution('excused', { ...p, excusedExcluded: false })).toEqual({ earned: 0, inDenominator: true });
  });

  it('null (no gradeable record / lookup_error / unexpected) -> no contribution (spec §24)', () => {
    expect(scoreContribution(null, p)).toBeNull();
  });
});
