// "Most-recent-record-wins" is the single rule for turning the append-only
// attendance_records table into one current status per member. Nothing else
// in this codebase should compute a member's current attendance status --
// route handlers and closeAttendanceSession() both call this function rather
// than re-deriving the rule.

import type { AttendanceRecordRow } from '../database/schema.js';

export function resolveCurrentRecord(records: AttendanceRecordRow[]): AttendanceRecordRow | null {
  if (records.length === 0) return null;

  return records.reduce((latest, candidate) => {
    const latestTime = new Date(latest.createdAt).getTime();
    const candidateTime = new Date(candidate.createdAt).getTime();
    if (candidateTime > latestTime) return candidate;
    if (candidateTime < latestTime) return latest;
    // Deterministic tie-break: higher id string wins. createdAt has only
    // millisecond precision, so two records inserted in the same millisecond
    // (e.g. a manual correction immediately following a scan) need a
    // stable, order-independent tiebreaker.
    return candidate.id > latest.id ? candidate : latest;
  });
}
