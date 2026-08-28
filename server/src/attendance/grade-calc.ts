// server/src/attendance/grade-calc.ts
//
// Cumulative attendance -> Canvas score (spec §27, §27.2). Pure: no DB, no Canvas.
//
// Population is decided by the caller (session-lifecycle.ts passes the course's CURRENT roster —
// course_members filtered to eligible learners — per the 2026-08-28 "current roster x all closed
// sessions" ruling). For each roster member we walk every CLOSED session (reopened sessions
// are excluded by the caller) and accumulate earned points + denominator per grade-policy.ts.
// Denominator 0 -> the member is omitted (spec §27.2 "do not submit a score").

import { type GradingPolicy, type GradeableStatus, scoreContribution } from './grade-policy.js';

export interface SessionResolvedStatuses {
  sessionId: string;
  // Only members with a gradeable resolved record (present | absent | excused) for this session.
  // A member absent from this map contributed no record to that session.
  statusByLtiUserId: Map<string, GradeableStatus>;
}

export interface CumulativeScore {
  scoreGiven: number;
  scoreMaximum: 100;
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

export function computeCumulativeScores(
  closedSessions: SessionResolvedStatuses[],
  rosterLtiUserIds: string[],
  policy: GradingPolicy,
): Map<string, CumulativeScore> {
  const result = new Map<string, CumulativeScore>();

  for (const ltiUserId of rosterLtiUserIds) {
    let earned = 0;
    let denominator = 0;

    for (const session of closedSessions) {
      const status = session.statusByLtiUserId.get(ltiUserId) ?? null;
      const contribution = scoreContribution(status, policy);
      if (contribution === null) continue;
      earned += contribution.earned;
      if (contribution.inDenominator) denominator += 1;
    }

    if (denominator === 0) continue; // spec §27.2
    result.set(ltiUserId, { scoreGiven: round4((earned / denominator) * 100), scoreMaximum: 100 });
  }

  return result;
}
