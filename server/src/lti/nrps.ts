//
// Fetches and normalizes a course's Canvas roster via NRPS (spec §18). CourseRosterMember /
// CourseRosterResult / refreshCourseRoster form a fixed contract Phase 5 snapshots verbatim -- do not
// rename or reshape without updating Phase 5's plan document too.

import type { NrpsRawMember } from './roster-config.js';
import { resolveInstitutionalId, isEligibleForAttendance, type InstitutionRosterConfig } from './roster-config.js';

export interface CourseRosterMember {
  ltiUserId: string;
  institutionalId: string | null;
  displayName: string | null;
  givenName: string | null;
  familyName: string | null;
  email: string | null;
  roles: string[];
  status: string;
  eligibleForAttendance: boolean;
}

export type CourseRosterErrorKind =
  | 'invalid-service-url'
  | 'expired-token'
  | 'rate-limited'
  | 'pagination-failure'
  | 'network'
  | 'http-status'
  | 'bad-json';

export type CourseRosterResult =
  | { ok: true; members: CourseRosterMember[]; fetchedAt: string }
  | { ok: false; error: { kind: CourseRosterErrorKind; message: string; retryable: boolean } };

interface RawPagesError {
  kind: CourseRosterErrorKind;
  message: string;
  retryable: boolean;
  retryAfterSeconds?: number;
}

export type FetchRawMembershipPagesResult =
  | { ok: true; members: NrpsRawMember[] }
  | { ok: false; error: RawPagesError };

const MAX_PAGES = 100;

function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="?next"?/);
    if (match) return match[1];
  }
  return null;
}

export async function fetchRawMembershipPages(
  nrpsUrl: string,
  accessToken: string,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<FetchRawMembershipPagesResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const members: NrpsRawMember[] = [];
  let nextUrl: string | null = nrpsUrl;
  let pageCount = 0;

  while (nextUrl) {
    if (pageCount >= MAX_PAGES) {
      return {
        ok: false,
        error: { kind: 'pagination-failure', message: `Exceeded maximum of ${MAX_PAGES} NRPS pages.`, retryable: false },
      };
    }
    pageCount += 1;

    let response: Response;
    try {
      response = await fetchImpl(nextUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.ims.lti-nrps.v2.membershipcontainer+json',
        },
        redirect: 'manual',
      });
    } catch (err) {
      return {
        ok: false,
        error: { kind: 'network', message: err instanceof Error ? err.message : 'Network error fetching NRPS page.', retryable: true },
      };
    }

    if (response.status >= 300 && response.status < 400) {
      return {
        ok: false,
        error: { kind: 'pagination-failure', message: 'NRPS response was a redirect; redirects are not followed.', retryable: false },
      };
    }
    if (response.status === 401) {
      return {
        ok: false,
        error: { kind: 'expired-token', message: 'Canvas rejected the access token as expired or invalid.', retryable: true },
      };
    }
    if (response.status === 429) {
      const retryAfterHeader = response.headers.get('retry-after');
      const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : undefined;
      return {
        ok: false,
        error: {
          kind: 'rate-limited',
          message: `Canvas rate-limited the NRPS request (Retry-After: ${retryAfterHeader ?? 'unspecified'}).`,
          retryable: true,
          retryAfterSeconds,
        },
      };
    }
    if (!response.ok) {
      return { ok: false, error: { kind: 'http-status', message: `NRPS returned HTTP ${response.status}.`, retryable: false } };
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      return { ok: false, error: { kind: 'bad-json', message: 'NRPS response body was not valid JSON.', retryable: false } };
    }

    if (typeof json !== 'object' || json === null || !Array.isArray((json as { members?: unknown }).members)) {
      return {
        ok: false,
        error: { kind: 'pagination-failure', message: 'NRPS response was missing a "members" array.', retryable: false },
      };
    }
    members.push(...(json as { members: NrpsRawMember[] }).members);

    nextUrl = parseNextLink(response.headers.get('link'));
  }

  return { ok: true, members };
}

export function normalizeMember(raw: NrpsRawMember, config: InstitutionRosterConfig): CourseRosterMember {
  const roles = Array.isArray(raw.roles) ? raw.roles : [];
  return {
    ltiUserId: raw.user_id,
    institutionalId: resolveInstitutionalId(raw, config),
    displayName: raw.name ?? null,
    givenName: raw.given_name ?? null,
    familyName: raw.family_name ?? null,
    email: raw.email ?? null,
    roles,
    status: raw.status,
    eligibleForAttendance: isEligibleForAttendance(raw.status, roles, config.rosterLearnerRoles),
  };
}
