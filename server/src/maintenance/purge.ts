// server/src/maintenance/purge.ts
//
// Housekeeping the worker runs every pass alongside grade sync (spec §35.2: "expired OIDC
// transactions / expired application sessions / retention/purge tasks").
//
// Retention is deliberately conservative for Phase 7: only audit_events beyond RETENTION_DAYS are
// pruned. Pruning attendance data needs the per-institution retention policy from Phase 8
// (spec §34) — it is not done here.

import { sql } from 'drizzle-orm';
import type { Database } from '../database/client.js';

interface MaintenanceOpts {
  retentionDays?: number;
  now?: () => Date;
  shouldStop?: () => boolean;
}

export interface MaintenanceResult {
  oidcPurged: number;
  sessionsPurged: number;
  retentionDeleted: number;
}

export async function runMaintenancePass(db: Database, opts: MaintenanceOpts): Promise<MaintenanceResult> {
  const now = (opts.now ?? (() => new Date()))();
  const result: MaintenanceResult = { oidcPurged: 0, sessionsPurged: 0, retentionDeleted: 0 };

  if (opts.shouldStop?.()) return result;
  const oidc = await db.execute(sql`DELETE FROM oidc_transactions WHERE expires_at < ${now}`);
  result.oidcPurged = oidc.rowCount ?? 0;

  if (opts.shouldStop?.()) return result;
  const sessions = await db.execute(sql`DELETE FROM app_sessions WHERE expires_at < ${now}`);
  result.sessionsPurged = sessions.rowCount ?? 0;

  if (opts.shouldStop?.()) return result;
  if (opts.retentionDays && opts.retentionDays > 0) {
    const cutoff = new Date(now.getTime() - opts.retentionDays * 24 * 60 * 60 * 1000);
    const audit = await db.execute(sql`DELETE FROM audit_events WHERE created_at < ${cutoff}`);
    result.retentionDeleted = audit.rowCount ?? 0;
  }

  return result;
}
