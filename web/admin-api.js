// admin-api.js
//
// Pure client for the admin/setup API (Feature 3). Same never-throws convention as
// course-roster.js: every call resolves to {ok, ...} / {ok:false, error:{kind,message,status?}}.
// No DOM.
//
// Two auth modes, transparently:
//   - session: bootstrapSession() primes the CSRF token; apiFetch attaches x-csrf-token.
//   - setup token: setSetupToken('...') -> every call also sends x-setup-token.

import { apiFetch, bootstrapSession } from './api-client.js';

let setupToken = null;

/** @param {string|null} token */
export function setSetupToken(token) {
  setupToken = token && token.trim() ? token.trim() : null;
}

export function hasSetupToken() {
  return setupToken !== null;
}

function extraHeaders() {
  return setupToken ? { 'x-setup-token': setupToken } : {};
}

async function call(url, options = {}) {
  let response;
  try {
    response = await apiFetch(url, { ...options, headers: { ...extraHeaders(), ...(options.headers ?? {}) } });
  } catch (err) {
    return { ok: false, error: { kind: 'network', message: `Request to ${url} failed: ${err.message}` } };
  }
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    return {
      ok: false,
      error: { kind: 'http-status', message: `${url} returned HTTP ${response.status}`, status: response.status },
      body,
    };
  }
  return { ok: true, body: body ?? {} };
}

/**
 * Probes access. Returns one of:
 *   { state: 'token' }         -- no session; the setup-token form should be shown.
 *   { state: 'forbidden' }     -- signed in, but the Canvas role can't manage setup.
 *   { state: 'ok', me }        -- authorized (admin session or a valid setup token).
 */
export async function checkAccess() {
  const boot = await bootstrapSession();
  const probe = await call('/api/admin/registrations');
  if (probe.ok) {
    return { state: 'ok', me: boot.ok ? boot.me : null };
  }
  if (boot.ok && !hasSetupToken()) {
    return { state: 'forbidden', me: boot.me };
  }
  return { state: 'token' };
}

export function listRegistrations() {
  return call('/api/admin/registrations');
}

/** @param {Record<string, string>} body */
export function upsertRegistration(body) {
  return call('/api/admin/registrations', { method: 'POST', body });
}

/** @param {string} id @param {boolean} enabled */
export function toggleRegistration(id, enabled) {
  return call(`/api/admin/registrations/${encodeURIComponent(id)}/toggle`, { method: 'POST', body: { enabled } });
}

export function getSigningKey() {
  return call('/api/admin/signing-key');
}

export function rotateSigningKey() {
  return call('/api/admin/signing-key/rotate', { method: 'POST' });
}
