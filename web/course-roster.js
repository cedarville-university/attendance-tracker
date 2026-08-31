// course-roster.js
//
// Pure client for the Canvas course roster (Phase 4 backend: GET /api/course/roster,
// POST /api/course/roster/refresh). Same never-throws convention as attendance-session.js:
// every function returns a normalized {ok, ...} / {ok:false, error} result. No DOM.

import { apiFetch } from './api-client.js';
import { normalizeId } from './roster.js';

/**
 * @typedef {Object} CanvasRosterMember
 * @property {string} ltiUserId
 * @property {string|null} institutionalId
 * @property {string|null} displayName
 * @property {string|null} givenName
 * @property {string|null} familyName
 * @property {string|null} email
 * @property {string[]} roles
 * @property {string} status
 * @property {boolean} eligibleForAttendance
 */

/**
 * @typedef {{ok: true, members: CanvasRosterMember[], fetchedAt: string, stale: boolean}
 *          | {ok: false, error: {kind: 'network'|'http-status'|'bad-json', message: string, status?: number}}} RosterResult
 */

/** @param {Response} response @param {string} url @returns {Promise<RosterResult>} */
async function readRosterResponse(response, url) {
  if (!response.ok) {
    return { ok: false, error: { kind: 'http-status', message: `${url} returned HTTP ${response.status}`, status: response.status } };
  }
  try {
    const body = await response.json();
    return {
      ok: true,
      members: Array.isArray(body?.members) ? body.members : [],
      fetchedAt: typeof body?.fetchedAt === 'string' ? body.fetchedAt : '',
      stale: body?.stale === true,
    };
  } catch (err) {
    return { ok: false, error: { kind: 'bad-json', message: `${url} returned invalid JSON: ${err.message}` } };
  }
}

/** GET /api/course/roster. Never throws. @returns {Promise<RosterResult>} */
export async function fetchCourseRoster() {
  const url = '/api/course/roster';
  let response;
  try {
    response = await apiFetch(url);
  } catch (err) {
    return { ok: false, error: { kind: 'network', message: `Request to ${url} failed: ${err.message}` } };
  }
  return readRosterResponse(response, url);
}

/** POST /api/course/roster/refresh (CSRF-gated, bodyless). Never throws. @returns {Promise<RosterResult>} */
export async function refreshCourseRoster() {
  const url = '/api/course/roster/refresh';
  let response;
  try {
    response = await apiFetch(url, { method: 'POST' });
  } catch (err) {
    return { ok: false, error: { kind: 'network', message: `Request to ${url} failed: ${err.message}` } };
  }
  return readRosterResponse(response, url);
}

/**
 * Index eligible members by normalized institutional ID, for absent-diffing and
 * name lookup against a scan's institutional ID. Members with no institutional
 * ID cannot be matched to a scan and are omitted.
 * @param {CanvasRosterMember[]} members
 * @returns {Map<string, CanvasRosterMember>}
 */
export function buildMemberIndex(members) {
  const index = new Map();
  for (const member of members) {
    if (!member.eligibleForAttendance || !member.institutionalId) continue;
    index.set(normalizeId(member.institutionalId), member);
  }
  return index;
}

/** @param {CanvasRosterMember[]} members @returns {number} */
export function countEligible(members) {
  return members.reduce((n, m) => (m.eligibleForAttendance ? n + 1 : n), 0);
}
