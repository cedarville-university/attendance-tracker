//
// One place that knows the CSRF token and how to send an authenticated
// mutation. Every Phase 5 client mutation goes through apiFetch(); without
// the x-csrf-token header the server (Task 12's requireCsrf) returns 403.

let csrfToken = null;
let me = null;

/** GET /api/me; cache csrfToken + payload. Never throws. Call once from app.js init(). */
export async function bootstrapSession() {
  let response;
  try {
    response = await fetch('/api/me', { method: 'GET', headers: { Accept: 'application/json' } });
  } catch (err) {
    return { ok: false, error: { kind: 'network', message: `GET /api/me failed: ${err.message}` } };
  }
  if (!response.ok) {
    return { ok: false, error: { kind: 'http-status', message: `GET /api/me returned HTTP ${response.status}` } };
  }
  try {
    me = await response.json();
  } catch (err) {
    return { ok: false, error: { kind: 'bad-json', message: `GET /api/me returned invalid JSON: ${err.message}` } };
  }
  csrfToken = me?.csrfToken ?? null;
  return { ok: true, me };
}

export function getCsrfToken() {
  return csrfToken;
}

/**
 * fetch() wrapper: for a non-GET method, JSON-encodes `body` (when present),
 * sets a JSON content type ONLY when a body is actually sent, and attaches
 * x-csrf-token. GET requests pass straight through.
 *
 * The Content-Type header is conditional because Fastify's JSON body parser
 * rejects a request that declares `Content-Type: application/json` but carries
 * no body with `400 Body cannot be empty` -- which is exactly the shape of the
 * bodyless mutations here (close / grade-sync retry).
 * @param {string} url
 * @param {{ method?: string, body?: unknown, headers?: Record<string,string> }} [options]
 * @returns {Promise<Response>}
 */
export function apiFetch(url, options = {}) {
  const method = (options.method ?? 'GET').toUpperCase();
  if (method === 'GET') {
    return fetch(url, { method: 'GET', headers: { Accept: 'application/json', ...(options.headers ?? {}) } });
  }
  const hasBody = options.body !== undefined;
  return fetch(url, {
    method,
    headers: {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      Accept: 'application/json',
      'x-csrf-token': csrfToken ?? '',
      ...(options.headers ?? {}),
    },
    body: hasBody ? JSON.stringify(options.body) : undefined,
  });
}
