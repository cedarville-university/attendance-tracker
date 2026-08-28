import { describe, it, expect } from 'vitest';
import { computeCumulativeScores } from '../../src/attendance/grade-calc.js';
import { DEFAULT_GRADING_POLICY } from '../../src/attendance/grade-policy.js';

const P = DEFAULT_GRADING_POLICY;

function session(sessionId: string, entries: Record<string, 'present' | 'absent' | 'excused'>) {
  return { sessionId, statusByLtiUserId: new Map(Object.entries(entries)) };
}

describe('computeCumulativeScores', () => {
  it('is 100 for a member present in every closed session', () => {
    const scores = computeCumulativeScores(
      [session('s1', { u1: 'present' }), session('s2', { u1: 'present' })],
      ['u1'],
      P,
    );
    expect(scores.get('u1')).toEqual({ scoreGiven: 100, scoreMaximum: 100 });
  });

  it('is 50 for a member present in half of the closed sessions', () => {
    const scores = computeCumulativeScores(
      [session('s1', { u1: 'present' }), session('s2', { u1: 'absent' })],
      ['u1'],
      P,
    );
    expect(scores.get('u1')).toEqual({ scoreGiven: 50, scoreMaximum: 100 });
  });

  it('excludes an excused session from the denominator', () => {
    // present, excused, absent -> earned 1 / denominator 2 -> 50
    const scores = computeCumulativeScores(
      [session('s1', { u1: 'present' }), session('s2', { u1: 'excused' }), session('s3', { u1: 'absent' })],
      ['u1'],
      P,
    );
    expect(scores.get('u1')).toEqual({ scoreGiven: 50, scoreMaximum: 100 });
  });

  it('skips a session where the member has no gradeable record (mid-term add/drop)', () => {
    // u2 only appears in s2 -> denominator 1, present -> 100
    const scores = computeCumulativeScores(
      [session('s1', { u1: 'present' }), session('s2', { u1: 'present', u2: 'present' })],
      ['u1', 'u2'],
      P,
    );
    expect(scores.get('u2')).toEqual({ scoreGiven: 100, scoreMaximum: 100 });
  });

  it('omits a member whose denominator is 0 (only excused, or no records at all)', () => {
    const scores = computeCumulativeScores(
      [session('s1', { u1: 'excused' })],
      ['u1', 'u3'],
      P,
    );
    expect(scores.has('u1')).toBe(false); // only-excused -> denominator 0
    expect(scores.has('u3')).toBe(false); // never appears
  });

  it('returns an empty map when there are no closed sessions', () => {
    expect(computeCumulativeScores([], ['u1'], P).size).toBe(0);
  });

  it('rounds scoreGiven to at most 4 decimal places', () => {
    // 1 of 3 -> 33.3333...
    const scores = computeCumulativeScores(
      [session('s1', { u1: 'present' }), session('s2', { u1: 'absent' }), session('s3', { u1: 'absent' })],
      ['u1'],
      P,
    );
    expect(scores.get('u1')!.scoreGiven).toBeCloseTo(33.3333, 4);
  });
});
