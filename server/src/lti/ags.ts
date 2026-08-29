// server/src/lti/ags.ts
//
// Dumb authenticated HTTP against Canvas AGS (spec §27, §27.1, §27.3). Mirrors nrps.ts's
// fetchRawMembershipPages: this module never acquires a token (the caller passes one) and never
// retries (the caller — grade-worker.ts — owns the retry loop). It only performs one request and
// classifies the outcome into AgsResult. The line-items URL and every derived score URL come from
// the launch-persisted courses.ags_lineitems_url, used verbatim through validateCanvasServiceUrl
// (structural check only — spec §31.7 trust anchor is the signed launch's provenance).

import { validateCanvasServiceUrl } from './service-url.js';
import { assertSameOrigin } from '../security/same-origin.js';

export const ATTENDANCE_RESOURCE_ID = 'attendance-cumulative-v1';
export const ATTENDANCE_TAG = 'attendance';
export const ATTENDANCE_LABEL = 'Attendance';
export const ATTENDANCE_SCORE_MAXIMUM = 100;

export type AgsErrorKind =
  | 'invalid-service-url'
  | 'rate-limited'
  | 'auth'
  | 'client-error'
  | 'server-error'
  | 'network'
  | 'bad-json';

export interface AgsError {
  kind: AgsErrorKind;
  message: string;
  status?: number;
  retryAfterSeconds?: number;
  retryable: boolean;
}

export type AgsResult<T> = { ok: true; value: T } | { ok: false; error: AgsError };

export interface EnsuredLineItem {
  canvasLineItemId: string;
  canvasLineItemUrl: string;
  resourceId: string;
  tag: string;
  scoreMaximum: number;
}

export interface AgsScoreInput {
  userId: string;
  scoreGiven: number;
  scoreMaximum: number;
  timestamp: string;
}

const LINEITEM_CONTENT_TYPE = 'application/vnd.ims.lis.v2.lineitem+json';
const LINEITEM_CONTAINER_ACCEPT = 'application/vnd.ims.lis.v2.lineitemcontainer+json';
const SCORE_CONTENT_TYPE = 'application/vnd.ims.lis.v1.score+json';

// The thrown error is deliberately discarded: nothing from a fetch rejection (hostname, socket
// path, Canvas response detail) is safe to persist (spec §31.9). The param must be named `_err` to
// satisfy `@typescript-eslint/no-unused-vars`'s `argsIgnorePattern: '^_'` (eslint.config.js) —
// `args: 'after-used'` reports the last parameter when it is the only one and unused.
function networkError(_err: unknown): AgsResult<never> {
  return {
    ok: false,
    error: { kind: 'network', message: 'ags:network', retryable: true },
  };
}

function badJson(): AgsResult<never> {
  return { ok: false, error: { kind: 'bad-json', message: 'ags:bad-json', retryable: false } };
}

/** null => the response is a usable 2xx. Otherwise an AgsResult error to return. */
function classifyResponse(response: Response): AgsResult<never> | null {
  const status = response.status;
  if (status >= 200 && status < 300) return null;
  if (status >= 300 && status < 400) {
    return { ok: false, error: { kind: 'server-error', message: 'ags:redirect', status, retryable: true } };
  }
  if (status === 401) {
    return { ok: false, error: { kind: 'auth', message: 'ags:auth', status, retryable: true } };
  }
  if (status === 429) {
    const header = response.headers.get('retry-after');
    const retryAfterSeconds = header ? Number(header) : undefined;
    return {
      ok: false,
      error: {
        kind: 'rate-limited',
        message: 'ags:rate-limited',
        status,
        retryAfterSeconds: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined,
        retryable: true,
      },
    };
  }
  if (status >= 500) {
    return { ok: false, error: { kind: 'server-error', message: 'ags:server-error', status, retryable: true } };
  }
  // Any other 4xx is a permanent validation error (spec §28: do not auto-retry).
  return { ok: false, error: { kind: 'client-error', message: 'ags:client-error', status, retryable: false } };
}

function lastSegment(url: string): string {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    return parts[parts.length - 1] ?? url;
  } catch {
    return url;
  }
}

function toEnsured(raw: Record<string, unknown>): EnsuredLineItem {
  const url = String(raw.id);
  return {
    canvasLineItemId: lastSegment(url),
    canvasLineItemUrl: url,
    resourceId: typeof raw.resourceId === 'string' ? raw.resourceId : ATTENDANCE_RESOURCE_ID,
    tag: typeof raw.tag === 'string' ? raw.tag : ATTENDANCE_TAG,
    scoreMaximum: typeof raw.scoreMaximum === 'number' ? raw.scoreMaximum : ATTENDANCE_SCORE_MAXIMUM,
  };
}

// Backlog 6.1: the line-item `id` comes from a Canvas response body; before any later bearer-token
// score POST targets it, confirm it is on the same origin as the launch-persisted line-items URL.
function ensuredOrUntrusted(
  raw: Record<string, unknown>,
  lineItemsUrl: string,
): AgsResult<EnsuredLineItem> {
  const ensured = toEnsured(raw);
  try {
    assertSameOrigin(ensured.canvasLineItemUrl, lineItemsUrl);
  } catch {
    return {
      ok: false,
      error: { kind: 'client-error', message: 'ags:untrusted-lineitem-origin', retryable: false },
    };
  }
  return { ok: true, value: ensured };
}

export async function ensureLineItem(
  lineItemsUrl: string,
  accessToken: string,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<AgsResult<EnsuredLineItem>> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const urlCheck = validateCanvasServiceUrl(lineItemsUrl);
  if (!urlCheck.ok) {
    return { ok: false, error: { kind: 'invalid-service-url', message: 'ags:invalid-service-url', retryable: false } };
  }

  // 1. Query existing tool line items by the stable tag + resourceId (spec §27.1 step 1).
  const separator = lineItemsUrl.includes('?') ? '&' : '?';
  const queryUrl = `${lineItemsUrl}${separator}tag=${encodeURIComponent(ATTENDANCE_TAG)}&resource_id=${encodeURIComponent(ATTENDANCE_RESOURCE_ID)}`;
  let listResponse: Response;
  try {
    listResponse = await fetchImpl(queryUrl, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: LINEITEM_CONTAINER_ACCEPT },
      redirect: 'manual',
    });
  } catch (err) {
    return networkError(err);
  }
  const listError = classifyResponse(listResponse);
  if (listError) return listError;

  let listJson: unknown;
  try {
    listJson = await listResponse.json();
  } catch {
    return badJson();
  }
  const existing = Array.isArray(listJson) ? (listJson as Array<Record<string, unknown>>) : [];
  const match = existing.find(
    (li) => li && li.tag === ATTENDANCE_TAG && li.resourceId === ATTENDANCE_RESOURCE_ID && typeof li.id === 'string',
  );
  if (match) return ensuredOrUntrusted(match, lineItemsUrl); // spec §27.1 step 2 — reuse

  // 2. Create only if none exists (spec §27.1 step 3). Canvas dedupes on resourceId, so a
  //    concurrent double-create still converges — this operation is idempotent.
  let createResponse: Response;
  try {
    createResponse = await fetchImpl(lineItemsUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': LINEITEM_CONTENT_TYPE },
      body: JSON.stringify({
        scoreMaximum: ATTENDANCE_SCORE_MAXIMUM,
        label: ATTENDANCE_LABEL,
        resourceId: ATTENDANCE_RESOURCE_ID,
        tag: ATTENDANCE_TAG,
      }),
      redirect: 'manual',
    });
  } catch (err) {
    return networkError(err);
  }
  const createError = classifyResponse(createResponse);
  if (createError) return createError;

  let createdJson: unknown;
  try {
    createdJson = await createResponse.json();
  } catch {
    return badJson();
  }
  if (!createdJson || typeof (createdJson as Record<string, unknown>).id !== 'string') {
    return badJson();
  }
  return ensuredOrUntrusted(createdJson as Record<string, unknown>, lineItemsUrl);
}

export async function postScore(
  lineItemUrl: string,
  accessToken: string,
  score: AgsScoreInput,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<AgsResult<void>> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const urlCheck = validateCanvasServiceUrl(lineItemUrl);
  if (!urlCheck.ok) {
    return { ok: false, error: { kind: 'invalid-service-url', message: 'ags:invalid-service-url', retryable: false } };
  }
  const scoresUrl = `${lineItemUrl.replace(/\/$/, '')}/scores`;

  let response: Response;
  try {
    response = await fetchImpl(scoresUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': SCORE_CONTENT_TYPE },
      body: JSON.stringify({
        userId: score.userId,
        scoreGiven: score.scoreGiven,
        scoreMaximum: score.scoreMaximum,
        activityProgress: 'Completed',
        gradingProgress: 'FullyGraded',
        timestamp: score.timestamp,
      }),
      redirect: 'manual',
    });
  } catch (err) {
    return networkError(err);
  }
  const error = classifyResponse(response);
  if (error) return error;
  return { ok: true, value: undefined };
}
