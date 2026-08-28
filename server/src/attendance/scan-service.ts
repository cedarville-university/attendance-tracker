// The scan pipeline's server-side counterpart. Every branch here is
// release-blocking per spec §47: identity resolution failures must become a
// recorded 'lookup_error' scan, not a lost/silently-dropped one; an
// ambiguous roster match must never resolve to 'present' (spec §20); and a
// retry of a scan that previously landed as 'lookup_error' MUST be able to
// recover to 'present'/'unexpected' (spec §47 "duplicate after lookup
// failure retries lookup").

import { and, eq } from 'drizzle-orm';
import type { Database } from '../database/client.js';
import { attendanceSessions, attendanceSessionMembers, attendanceRecords, type AttendanceRecordRow } from '../database/schema.js';
import type { IdentityResolver } from '../identity/types.js';
import { computeCardFingerprint } from './card-fingerprint.js';
import { SessionClosedError } from './session-lifecycle.js';

export interface SubmitScanInput {
  clientScanId: string;
  cardCode: string;
  scannedAt: string;
}
export interface SubmitScanDeps {
  resolver: IdentityResolver;
  institution: { id: string; cardFingerprintEnabled: boolean };
}

export async function submitScan(
  db: Database,
  sessionId: string,
  input: SubmitScanInput,
  deps: SubmitScanDeps,
): Promise<AttendanceRecordRow> {
  // Idempotency (spec §21/§47): a retried submission with the same clientScanId
  // returns the existing record WITHOUT calling the resolver again -- UNLESS
  // that existing record is a 'lookup_error'. A lookup_error is not a settled
  // outcome; a retry must re-run resolution and update the row in place so the
  // student can still land 'present' after a card-API outage (B6). The
  // (attendanceSessionId, clientScanId) unique index forbids a second row, so
  // re-resolution updates the same row rather than inserting.
  const [existing] = await db
    .select()
    .from(attendanceRecords)
    .where(and(eq(attendanceRecords.attendanceSessionId, sessionId), eq(attendanceRecords.clientScanId, input.clientScanId)));
  if (existing && existing.status !== 'lookup_error') return existing;

  const [session] = await db.select().from(attendanceSessions).where(eq(attendanceSessions.id, sessionId));
  // Defensive only: the route resolves tenancy and returns 404 before calling this.
  if (!session) throw new SessionClosedError();
  if (session.state === 'closed') throw new SessionClosedError();

  const resolution = await deps.resolver.resolveCard(input.cardCode);

  let status: AttendanceRecordRow['status'];
  let ltiUserId: string | null = null;
  let institutionalId: string | null = null;
  let lookupErrorKind: string | null = null;

  if (!resolution.ok) {
    status = 'lookup_error';
    lookupErrorKind = resolution.error?.kind ?? 'unknown';
  } else if (resolution.universityId == null) {
    // ok:true with no university id is a lookup FAILURE, not an unexpected
    // student (spec §20 -- "a card lookup failure is not the same as an
    // unexpected student").
    status = 'lookup_error';
    lookupErrorKind = 'missing-university-id';
  } else {
    institutionalId = resolution.universityId;
    const matches = await db
      .select()
      .from(attendanceSessionMembers)
      .where(and(eq(attendanceSessionMembers.attendanceSessionId, sessionId), eq(attendanceSessionMembers.institutionalId, institutionalId)));

    if (matches.length === 1) {
      status = 'present';
      ltiUserId = matches[0].ltiUserId;
    } else {
      // Zero matches (not on roster) or more than one (ambiguous) both resolve
      // to 'unexpected' -- an ambiguous match must never become 'present' (spec §20).
      status = 'unexpected';
    }
  }

  const cardFingerprint = deps.institution.cardFingerprintEnabled
    ? computeCardFingerprint(input.cardCode, cardFingerprintSecretFor(deps.institution.id))
    : null;

  // Re-resolution of a prior lookup_error: update that row in place.
  if (existing) {
    const [updated] = await db
      .update(attendanceRecords)
      .set({ status, ltiUserId, institutionalId, lookupErrorKind, cardFingerprint, scannedAt: new Date(input.scannedAt), updatedAt: new Date() })
      .where(eq(attendanceRecords.id, existing.id))
      .returning();
    return updated;
  }

  const inserted = await db
    .insert(attendanceRecords)
    .values({
      attendanceSessionId: sessionId,
      ltiUserId,
      institutionalId,
      clientScanId: input.clientScanId,
      status,
      scannedAt: new Date(input.scannedAt),
      source: 'card',
      cardFingerprint,
      lookupErrorKind,
    })
    .onConflictDoNothing({ target: [attendanceRecords.attendanceSessionId, attendanceRecords.clientScanId] })
    .returning();

  if (inserted.length === 1) return inserted[0];

  // Lost the race to a concurrent identical submission (HTTP response lost, client
  // retried while the first request was still committing) -- the winner is already
  // there; return it.
  const [winner] = await db
    .select()
    .from(attendanceRecords)
    .where(and(eq(attendanceRecords.attendanceSessionId, sessionId), eq(attendanceRecords.clientScanId, input.clientScanId)));
  return winner;
}

// Card-fingerprint secret is app-wide (env var), not per-institution, since only
// one institution is live at this stage. The institutionId parameter is retained
// so a future per-institution secret is a one-function change -- see "Risks /
// open items" for the migration path.  (User ruling 2026-08-27: app-wide confirmed
// for Phase 5; per-institution secret is documented future work.)
function cardFingerprintSecretFor(_institutionId: string): string {
  const secret = process.env.CARD_FINGERPRINT_SECRET;
  if (!secret) throw new Error('CARD_FINGERPRINT_SECRET must be set when card fingerprinting is enabled.');
  return secret;
}
