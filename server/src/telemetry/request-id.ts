// server/src/telemetry/request-id.ts
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { metrics } from './metrics.js';
import { safeLogFields } from './logger.js';

const SAFE_REQUEST_ID = /^[A-Za-z0-9._~-]{1,128}$/;

export function genReqId(req: Pick<FastifyRequest, 'headers'>): string {
  const inbound = req.headers['x-request-id'];
  if (typeof inbound === 'string' && SAFE_REQUEST_ID.test(inbound)) return inbound;
  return randomUUID();
}

export function registerRequestTelemetry(app: FastifyInstance): void {
  app.addHook('onResponse', async (request, reply) => {
    const durationMs = Math.round(reply.elapsedTime);
    const httpStatus = reply.statusCode;
    metrics.httpRequestLatencyMs.record(durationMs, { route: request.routeOptions?.url ?? 'unrouted' });
    if (httpStatus >= 500) {
      metrics.http5xx.add(1, { route: request.routeOptions?.url ?? 'unrouted' });
    }
    request.log.info(
      safeLogFields(request, {
        httpStatus,
        durationMs,
        environment: process.env.NODE_ENV ?? 'development',
        errorType: httpStatus >= 500 ? 'server_error' : httpStatus >= 400 ? 'client_error' : undefined,
      }),
      'request completed',
    );
  });
}
