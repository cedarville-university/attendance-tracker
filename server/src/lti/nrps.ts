//
// Fetches and normalizes a course's Canvas roster via NRPS (spec §18). CourseRosterMember /
// CourseRosterResult / refreshCourseRoster form a fixed contract Phase 5 snapshots verbatim -- do not
// rename or reshape without updating Phase 5's plan document too.

import { eq } from 'drizzle-orm';
import type { NrpsRawMember } from './roster-config.js';
import {
  resolveInstitutionalId,
  isEligibleForAttendance,
  resolveInstitutionRosterConfig,
  type InstitutionRosterConfig,
} from './roster-config.js';
import type { Database } from '../database/client.js';
import { courses, institutions, ltiDeployments, ltiRegistrations } from '../database/schema.js';
import type { ToolSigningKey } from './signing-keys.js';
import { validateCanvasServiceUrl } from './service-url.js';
import { getAccessToken, clearAccessTokenCache } from './token-client.js';
import { NRPS_MEMBERSHIP_READONLY_SCOPE } from './scopes.js';
import { upsertCourseMembers } from '../attendance/roster-store.js';

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

async function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface CourseRosterContext {
  courseId: string;
  nrpsUrl: string | null;
  registration: { id: string; clientId: string; tokenEndpoint: string; tokenAudience: string };
  institution: { canvasIdentityMatchField: string; identityMatchEmailEnabled: boolean; rosterLearnerRoles: string[] };
}

async function loadCourseRosterContext(db: Database, courseId: string): Promise<CourseRosterContext | null> {
  const rows = await db
    .select({
      courseId: courses.id,
      nrpsUrl: courses.nrpsUrl,
      canvasIdentityMatchField: institutions.canvasIdentityMatchField,
      identityMatchEmailEnabled: institutions.identityMatchEmailEnabled,
      rosterLearnerRoles: institutions.rosterLearnerRoles,
      registrationId: ltiRegistrations.id,
      registrationClientId: ltiRegistrations.clientId,
      registrationTokenEndpoint: ltiRegistrations.tokenEndpoint,
      registrationTokenAudience: ltiRegistrations.tokenAudience,
    })
    .from(courses)
    .innerJoin(institutions, eq(courses.institutionId, institutions.id))
    .innerJoin(ltiDeployments, eq(courses.deploymentId, ltiDeployments.id))
    .innerJoin(ltiRegistrations, eq(ltiDeployments.registrationId, ltiRegistrations.id))
    .where(eq(courses.id, courseId));

  const row = rows[0];
  if (!row) return null;

  return {
    courseId: row.courseId,
    nrpsUrl: row.nrpsUrl,
    registration: {
      id: row.registrationId,
      clientId: row.registrationClientId,
      tokenEndpoint: row.registrationTokenEndpoint,
      tokenAudience: row.registrationTokenAudience,
    },
    institution: {
      canvasIdentityMatchField: row.canvasIdentityMatchField,
      identityMatchEmailEnabled: row.identityMatchEmailEnabled,
      rosterLearnerRoles: row.rosterLearnerRoles,
    },
  };
}

export interface RefreshCourseRosterDeps {
  signingKey: ToolSigningKey;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  maxRateLimitRetries?: number;
}

export async function refreshCourseRoster(
  db: Database,
  courseId: string,
  deps: RefreshCourseRosterDeps,
): Promise<CourseRosterResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleepImpl = deps.sleepImpl ?? defaultSleep;
  const maxRateLimitRetries = deps.maxRateLimitRetries ?? 3;

  const context = await loadCourseRosterContext(db, courseId);
  if (!context) {
    return { ok: false, error: { kind: 'invalid-service-url', message: `Course ${courseId} not found.`, retryable: false } };
  }
  if (!context.nrpsUrl) {
    return {
      ok: false,
      error: { kind: 'invalid-service-url', message: 'Course has no NRPS service URL from its launch context.', retryable: false },
    };
  }

  const urlCheck = validateCanvasServiceUrl(context.nrpsUrl);
  if (!urlCheck.ok) {
    return {
      ok: false,
      error: { kind: 'invalid-service-url', message: `NRPS URL failed validation: ${urlCheck.error}`, retryable: false },
    };
  }

  const rosterConfig = resolveInstitutionRosterConfig(context.institution);
  let tokenRetried = false;
  let rateLimitAttempt = 0;

  for (;;) {
    let accessToken: string;
    try {
      accessToken = await getAccessToken(
        {
          id: context.registration.id,
          clientId: context.registration.clientId,
          tokenEndpoint: context.registration.tokenEndpoint,
          tokenAudience: context.registration.tokenAudience,
        },
        [NRPS_MEMBERSHIP_READONLY_SCOPE],
        { signingKey: deps.signingKey, fetchImpl },
      );
    } catch (err) {
      // Never throw on a transient Canvas failure (D9): a dead token endpoint is a retryable network error.
      return {
        ok: false,
        error: { kind: 'network', message: err instanceof Error ? err.message : 'Token acquisition failed.', retryable: true },
      };
    }

    const pages = await fetchRawMembershipPages(context.nrpsUrl, accessToken, { fetchImpl });

    if (pages.ok) {
      const members = pages.members.map((raw) => normalizeMember(raw, rosterConfig));
      const fetchedAt = new Date().toISOString();
      await upsertCourseMembers(db, courseId, members);
      return { ok: true, members, fetchedAt };
    }

    if (pages.error.kind === 'expired-token' && !tokenRetried) {
      tokenRetried = true;
      clearAccessTokenCache(context.registration.id, [NRPS_MEMBERSHIP_READONLY_SCOPE]);
      continue;
    }

    if (pages.error.kind === 'rate-limited' && rateLimitAttempt < maxRateLimitRetries) {
      rateLimitAttempt += 1;
      await sleepImpl((pages.error.retryAfterSeconds ?? 1) * 1000);
      continue;
    }

    return { ok: false, error: { kind: pages.error.kind, message: pages.error.message, retryable: pages.error.retryable } };
  }
}
