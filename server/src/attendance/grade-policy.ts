// server/src/attendance/grade-policy.ts
//
// Attendance -> Gradebook policy (spec §27.2). Pure: no DB, no Canvas. The default is
// present=1 / absent=0 / excused-excluded-from-denominator. Spec §27.2 says grading policy
// "must be configurable by institution"; the per-institution surface (an institutions.grading_policy
// column + an editor) is deferred to Phase 8 — this phase ships the documented default with a clean
// seam: any caller can pass a different GradingPolicy, and only DEFAULT_GRADING_POLICY is wired up.
// 'late' is intentionally absent — it is not in the attendance_records status enum this phase.

export interface GradingPolicy {
  presentPoints: number;
  absentPoints: number;
  excusedExcluded: boolean;
}

export const DEFAULT_GRADING_POLICY: GradingPolicy = {
  presentPoints: 1,
  absentPoints: 0,
  excusedExcluded: true,
};

export type GradeableStatus = 'present' | 'absent' | 'excused';

/**
 * The earned points + denominator membership for one member's resolved status in one session.
 * `null` status means "no gradeable record for this member-session" (member had no record, or the
 * only record is lookup_error/unexpected — spec §24): contributes nothing, not even a denominator.
 */
export function scoreContribution(
  status: GradeableStatus | null,
  policy: GradingPolicy,
): { earned: number; inDenominator: boolean } | null {
  if (status === null) return null;
  if (status === 'present') return { earned: policy.presentPoints, inDenominator: true };
  if (status === 'absent') return { earned: policy.absentPoints, inDenominator: true };
  // excused
  return policy.excusedExcluded
    ? { earned: 0, inDenominator: false }
    : { earned: policy.absentPoints, inDenominator: true };
}
