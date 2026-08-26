// absentees.js
//
// Computes the "Absent" rows for a CSV export: roster entries with no
// matching scan record. Kept separate from scan-pipeline.js since these
// rows never represent an actual scan -- they're synthesized entirely from
// the roster.
//
// Phase 2 retired the per-University-ID enrichment lookup this module used
// to perform (formerly lookup.js's lookupPerson()) rather than porting it
// server-side: an absent student never scanned a card, so there is no
// credentialed identity API this app needs to call on their behalf. Absent
// rows use only whatever fields the uploaded roster CSV already contains.
// Canvas NRPS (a later phase) will supply authoritative names for absent
// students once roster upload is replaced by a live course roster.

/**
 * @typedef {Object} AbsentRow
 * @property {string} id
 * @property {string} timestamp - '' (no scan ever happened)
 * @property {string} rawCardCode - '' (never scanned)
 * @property {string} universityId
 * @property {Record<string, any>} lookupData - always {} (no lookup is performed for absent rows)
 * @property {Record<string, string>} rosterData - the full matched roster CSV row
 * @property {string} rosterStatus - '' (deliberately not reusing ScanRecord's enum)
 * @property {string} status - '' (ditto)
 * @property {true} isAbsent - read by csv.js to derive the `attendance` column
 */

/**
 * Diffs the roster against the set of University IDs that have already
 * scanned, returning one row per roster entry with no matching scan.
 *
 * @param {Object} args
 * @param {{index: Map<string, Record<string,string>>}} args.rosterState
 * @param {Set<string>} args.scannedIds - normalized university IDs already scanned this session
 * @returns {AbsentRow[]}
 */
export function computeAbsentRows({ rosterState, scannedIds }) {
  const absentEntries = [...rosterState.index.entries()].filter(([id]) => !scannedIds.has(id));

  return absentEntries.map(([universityId, rosterRow]) => ({
    id: `absent-${universityId}`,
    timestamp: '',
    rawCardCode: '',
    universityId,
    lookupData: {},
    rosterData: rosterRow,
    rosterStatus: '',
    status: '',
    isAbsent: true,
  }));
}
