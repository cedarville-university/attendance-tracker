// server/src/routes/health.ts
//
// spec §38 — two probes. `live` = process is up (no I/O). `ready` = config parsed + database
// reachable. Readiness MUST NOT depend on Canvas (spec §38 explicit): a Canvas outage must not
// take this app out of the Container Apps load-balancer rotation.

import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../database/client.js';

const READY_DB_TIMEOUT_MS = 2000;

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

export function registerHealthRoutes(app: FastifyInstance, deps: { db: Database }): void {
  app.get('/health/live', async () => ({ status: 'ok' }));

  app.get('/health/ready', async (_request, reply) => {
    try {
      await withTimeout(deps.db.execute(sql`SELECT 1`), READY_DB_TIMEOUT_MS);
      return { status: 'ready' };
    } catch {
      return reply.code(503).send({ status: 'not-ready', checks: { db: false } });
    }
  });
}
