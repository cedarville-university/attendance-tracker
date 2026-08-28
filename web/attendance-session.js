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
 * @param {string} sessionId
 * @returns {Promise<{ok: true, body: object}|{ok: false, error: {kind: string, message: string}}>}
 */
export async function getAttendanceSession(sessionId) {
  return request(`/api/attendance-sessions/${sessionId}`);
}
