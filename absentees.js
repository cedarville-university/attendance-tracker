// absentees.js
//
// Computes the "Absent" rows for a CSV export: roster entries with no
// matching scan record, enriched via a per-University-ID lookup call
// (lookup.js's lookupPerson()) run with bounded concurrency. Kept separate
// from scan-pipeline.js since these rows never represent an actual scan --
// they're synthesized entirely from the roster + a fresh batch of lookups.

import { lookupPerson } from './lookup.js';

/**
 * @typedef {Object} AbsentRow
 * @property {string} id
 * @property {string} timestamp - '' (no scan ever happened)
 * @property {string} rawCardCode - '' (never scanned)
 * @property {string} universityId
 * @property {Record<string, any>} lookupData - {} if the person lookup failed
 * @property {Record<string, string>} rosterData - the full matched roster CSV row
 * @property {string} rosterStatus - '' (deliberately not reusing ScanRecord's enum)
 * @property {string} status - '' (ditto)
 * @property {true} isAbsent - read by csv.js to derive the `attendance` column
 */

/**
 * Diffs the roster against the set of University IDs that have already
 * scanned, then resolves the remaining ("absent") roster rows via
 * lookupPerson(), a handful at a time.
 *
 * @param {Object} args
 * @param {{index: Map<string, Record<string,string>>}} args.rosterState
 * @param {Set<string>} args.scannedIds - normalized university IDs already scanned this session
 * @param {Map<string, object>} args.cache - session-lifetime cache, mutated in place, keyed by normalized ID
 * @param {number} [args.concurrency]
 * @param {(progress: {done: number, total: number}) => void} [args.onProgress]
 * @param {() => boolean} [args.shouldAbort] - checked between pool items; in-flight requests still finish
 * @returns {Promise<AbsentRow[]>}
 */
export async function computeAbsentRows({ rosterState, scannedIds, cache, concurrency = 4, onProgress, shouldAbort }) {
  // Snapshot synchronously, before any await, so a roster reload/clear that
  // reassigns rosterState.index to a brand-new Map mid-fetch can't alter an
  // already-running batch (app.js always reassigns the index, never
  // mutates it in place).
  const absentEntries = [...rosterState.index.entries()].filter(([id]) => !scannedIds.has(id));
  const total = absentEntries.length;
  if (total === 0) return [];

  const rows = new Array(total);
  let nextIndex = 0;
  let completed = 0;

  async function resolveOne(universityId, rosterRow) {
    const cached = cache.get(universityId);
    let result = cached && cached.ok ? cached : await lookupPerson(universityId);
    cache.set(universityId, result);

    return {
      id: `absent-${universityId}`,
      timestamp: '',
      rawCardCode: '',
      universityId,
      lookupData: result.ok ? { firstName: result.firstName, lastName: result.lastName, email: result.email } : {},
      rosterData: rosterRow,
      rosterStatus: '',
      status: '',
      isAbsent: true,
    };
  }

  async function worker() {
    while (nextIndex < total) {
      if (shouldAbort && shouldAbort()) return;
      const myIndex = nextIndex++;
      const [universityId, rosterRow] = absentEntries[myIndex];
      rows[myIndex] = await resolveOne(universityId, rosterRow);
      completed += 1;
      onProgress?.({ done: completed, total });
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, total));
  await Promise.all(Array.from({ length: workerCount }, worker));

  // Sparse only if aborted mid-batch; the caller discards the whole result
  // in that case anyway, but filter defensively so a partial array is never
  // handed back with holes.
  return rows.filter(Boolean);
}
