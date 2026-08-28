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
 * @property {string} institutionalId - matches ScanRecord's field name (Phase 5 rename)
 * @property {string} status - '' (deliberately not reusing ScanRecord's enum)
 * @property {true} isAbsent - read by csv.js to derive the `attendance` column
 */

/**
 * Diffs the roster against the set of institutional IDs that have already
 * scanned, returning one row per roster entry with no matching scan.
 *
 * @param {Object} args
 * @param {{index: Map<string, Record<string,string>>}} args.rosterState
 * @param {Set<string>} args.scannedIds - normalized institutional IDs already scanned this session
 * @returns {AbsentRow[]}
 */
export function computeAbsentRows({ rosterState, scannedIds }) {
  const absentEntries = [...rosterState.index.entries()].filter(([id]) => !scannedIds.has(id));

  return absentEntries.map(([institutionalId]) => ({
    id: `absent-${institutionalId}`,
    timestamp: '',
    rawCardCode: '',
    institutionalId,
    status: '',
    isAbsent: true,
  }));
}
