// server/src/telemetry/logger.ts
//
// One pino configuration for the whole app (spec §31.8, §44). Fastify owns the logger instance;
// this module only supplies its options. Two jobs:
//  1. redact() — belt-and-suspenders removal of credential-bearing paths from any logged object;
//  2. safeLogFields() — the positive allowlist for the per-request access log, so a route that
//     logs `{ ...record }` can never leak a name / card code / student id.

import type { FastifyServerOptions, FastifyRequest } from 'fastify';
import type { Env } from '../config/env.js';

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
  '*.authorization',
  '*.id_token',
  '*.access_token',
  '*.refresh_token',
  '*.client_secret',
  '*.client_assertion',
  '*.cardCode',
  '*.rawCardCode',
  '*.privateKeyPkcs8Pem',
  '*.IDENTITY_API_KEY',
];

export function loggerOptions(env: Env): FastifyServerOptions['logger'] {
  const isProd = env.NODE_ENV === 'production';
  return {
    level: process.env.LOG_LEVEL ?? (isProd ? 'info' : 'debug'),
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    // pino-pretty only in local dev; production emits raw JSON lines that Container Apps ships to
    // Log Analytics.
    ...(isProd ? {} : { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:standard' } } }),
  };
}

// spec §44 "Structured logs should include safe fields such as:"
export const SAFE_LOG_FIELDS = [
  'timestamp',
  'level',
  'requestId',
  'environment',
  'route',
  'httpStatus',
  'durationMs',
  'institutionId',
  'courseInternalId',
  'attendanceSessionId',
  'errorType',
] as const;

export function safeLogFields(
  request: Pick<FastifyRequest, 'id'> & { routeOptions?: { url?: string }; url?: string },
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const merged: Record<string, unknown> = {
    requestId: request.id,
    route: request.routeOptions?.url ?? request.url,
    ...extra,
  };
  const out: Record<string, unknown> = {};
  for (const key of SAFE_LOG_FIELDS) {
    if (key in merged && merged[key] !== undefined) out[key] = merged[key];
  }
  return out;
}
