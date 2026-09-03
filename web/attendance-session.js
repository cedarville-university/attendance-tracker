// attendance-session.js
//
// Client-side lifecycle for a persisted attendance session: create, close,
// reopen, re-fetch. Same never-throws convention as scan-pipeline.js's
// submitScan(): every function returns a normalized {ok, ...} / {ok:false,
// error} result. Every request goes through api-client.js's apiFetch so a
// mutation carries x-csrf-token + a JSON body (Task 13 / D7).

import { apiFetch } from './api-client.js';

/** @param {string} url @param {{method?: string, body?: unknown}} [init] */
async function request(url, init = {}) {
  let response;
  try {
    if (Object.keys(init).length > 0) {
      response = await apiFetch(url, init);
    } else {
      response = await apiFetch(url);
    }
  } catch (err) {
    return { ok: false, error: { kind: 'network', message: `Request to ${url} failed: ${err.message}` } };
  }

  if (!response.ok) {
    let detail = '';
    try {
      detail = JSON.stringify(await response.json());
    } catch {
      // body wasn't JSON; empty detail
    }
    return { ok: false, error: { kind: 'http-status', message: `${url} returned HTTP ${response.status}${detail ? `: ${detail}` : ''}` } };
  }

  try {
    return { ok: true, body: await response.json() };
  } catch (err) {
    return { ok: false, error: { kind: 'bad-json', message: `${url} returned a response that was not valid JSON: ${err.message}` } };
  }
}

/**
 * @param {{label?: string, meetingAt?: string}} body
 * @returns {Promise<{ok: true, session: object}|{ok: false, error: {kind: string, message: string}}>}
 */
export async function createAttendanceSession(body) {
  const result = await request('/api/attendance-sessions', { method: 'POST', body });
  if (!result.ok) return result;
  return { ok: true, session: result.body };
}

/**
 * @param {string} sessionId
 * @returns {Promise<{ok: true}|{ok: false, error: {kind: string, message: string}}>}
 */
export async function closeAttendanceSession(sessionId) {
  const result = await request(`/api/attendance-sessions/${sessionId}/close`, { method: 'POST' });
  if (!result.ok) return result;
  return { ok: true };
}

/**
 * @param {string} sessionId
 * @param {string} [reason]
 * @returns {Promise<{ok: true}|{ok: false, error: {kind: string, message: string}}>}
 */
export async function reopenAttendanceSession(sessionId, reason) {
  const result = await request(`/api/attendance-sessions/${sessionId}/reopen`, { method: 'POST', body: { reason } });
  if (!result.ok) return result;
  return { ok: true };
}

/**
 * Re-queues this course's failed grade-sync jobs (spec §25.9). Never throws.
 * @param {string} sessionId
 * @returns {Promise<{ok: true, retried: number}|{ok: false, error: {kind: string, message: string}}>}
 */
export async function retryGradeSync(sessionId) {
  const result = await request(`/api/attendance-sessions/${sessionId}/grade-sync`, { method: 'POST' });
  if (!result.ok) return result;
  return { ok: true, retried: Number(result.body?.retried ?? 0) };
}

/**
 * @param {string} sessionId
 * @returns {Promise<{ok: true, body: object}|{ok: false, error: {kind: string, message: string}}>}
 */
export async function getAttendanceSession(sessionId) {
  return request(`/api/attendance-sessions/${sessionId}`);
}

/**
 * Lists this course's still-open (open | reopened) attendance sessions so the
 * client can resume after a page reload / Canvas re-launch (C1). Never throws.
 * @returns {Promise<{ok: true, sessions: object[]}|{ok: false, error: {kind: string, message: string}}>}
 */
export async function listOpenAttendanceSessions() {
  const result = await request('/api/attendance-sessions?state=open');
  if (!result.ok) return result;
  return { ok: true, sessions: Array.isArray(result.body?.sessions) ? result.body.sessions : [] };
}

/**
 * Deletes a single (mis-scanned) attendance record on the server (C2). Never throws.
 * @param {string} sessionId
 * @param {string} ltiUserId
 * @param {string} recordId
 * @returns {Promise<{ok: true}|{ok: false, error: {kind: string, message: string}}>}
 */
export async function deleteAttendanceRecord(sessionId, ltiUserId, recordId) {
  const url = `/api/attendance-sessions/${sessionId}/members/${encodeURIComponent(ltiUserId)}/records/${encodeURIComponent(recordId)}`;
  let response;
  try {
    response = await apiFetch(url, { method: 'DELETE' });
  } catch (err) {
    return { ok: false, error: { kind: 'network', message: `Request to ${url} failed: ${err.message}` } };
  }
  // A successful DELETE is 204 with no body -- don't try to parse JSON.
  if (!response.ok) {
    return { ok: false, error: { kind: 'http-status', message: `${url} returned HTTP ${response.status}` } };
  }
  return { ok: true };
}

/**
 * Applies a manual attendance correction for one rostered member (C2). Never throws.
 * @param {string} sessionId
 * @param {string} ltiUserId
 * @param {'present'|'absent'|'excused'} status
 * @returns {Promise<{ok: true, record: object}|{ok: false, error: {kind: string, message: string}}>}
 */
export async function correctMemberStatus(sessionId, ltiUserId, status) {
  const result = await request(`/api/attendance-sessions/${sessionId}/members/${encodeURIComponent(ltiUserId)}`, {
    method: 'PATCH',
    body: { status },
  });
  if (!result.ok) return result;
  return { ok: true, record: result.body };
}

/**
 * Fetches the server-authoritative attendance CSV text for a session (C2). Never
 * throws. Returns the raw CSV string on success.
 * @param {string} sessionId
 * @returns {Promise<{ok: true, csv: string, filename: string}|{ok: false, error: {kind: string, message: string}}>}
 */
export async function fetchAttendanceCsv(sessionId) {
  const url = `/api/attendance-sessions/${sessionId}/export.csv`;
  let response;
  try {
    response = await apiFetch(url);
  } catch (err) {
    return { ok: false, error: { kind: 'network', message: `Request to ${url} failed: ${err.message}` } };
  }
  if (!response.ok) {
    return { ok: false, error: { kind: 'http-status', message: `${url} returned HTTP ${response.status}` } };
  }
  try {
    const csv = await response.text();
    return { ok: true, csv, filename: `attendance-${sessionId}.csv` };
  } catch (err) {
    return { ok: false, error: { kind: 'bad-body', message: `${url} returned an unreadable body: ${err.message}` } };
  }
}

/**
 * Lists this course's full attendance-session history, newest-first (spec §25.11 / session
 * review). `includeDeleted` also returns soft-deleted sessions. Never throws.
 * @param {{includeDeleted?: boolean}} [opts]
 * @returns {Promise<{ok: true, sessions: object[]}|{ok: false, error: {kind: string, message: string}}>}
 */
export async function listSessionHistory({ includeDeleted = false } = {}) {
  const url = includeDeleted
    ? '/api/attendance-sessions/history?includeDeleted=1'
    : '/api/attendance-sessions/history';
  const result = await request(url);
  if (!result.ok) return result;
  return { ok: true, sessions: Array.isArray(result.body?.sessions) ? result.body.sessions : [] };
}

/**
 * Soft-deletes an attendance session created by accident (restorable). Never throws.
 * A successful DELETE is `200 { ok: true, lastClosedSessionRemoved }`; an unparseable
 * body degrades to `lastClosedSessionRemoved: false`. When `lastClosedSessionRemoved`
 * is true the server has scheduled durable removal of the course's Canvas attendance
 * line item (handled by the grade-sync worker); the caller only needs to inform the user.
 * @param {string} sessionId
 * @returns {Promise<{ok: true, lastClosedSessionRemoved: boolean}|{ok: false, error: {kind: string, message: string}}>}
 */
export async function deleteSession(sessionId) {
  const url = `/api/attendance-sessions/${sessionId}`;
  let response;
  try {
    response = await apiFetch(url, { method: 'DELETE' });
  } catch (err) {
    return { ok: false, error: { kind: 'network', message: `Request to ${url} failed: ${err.message}` } };
  }
  if (!response.ok) {
    return { ok: false, error: { kind: 'http-status', message: `${url} returned HTTP ${response.status}` } };
  }
  let body;
  try {
    body = await response.json();
  } catch {
    body = null; // a 2xx with no / unparseable body still counts as success
  }
  return { ok: true, lastClosedSessionRemoved: Boolean(body?.lastClosedSessionRemoved) };
}

/**
 * Restores a previously soft-deleted attendance session. Never throws.
 * @param {string} sessionId
 * @returns {Promise<{ok: true}|{ok: false, error: {kind: string, message: string}}>}
 */
export async function restoreSession(sessionId) {
  const result = await request(`/api/attendance-sessions/${sessionId}/restore`, { method: 'POST' });
  if (!result.ok) return result;
  return { ok: true };
}
