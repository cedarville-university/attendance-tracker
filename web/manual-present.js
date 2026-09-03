// manual-present.js
//
// Pure helper for the "Mark present" control: given the roster snapshot that
// `GET /api/attendance-sessions/:id` returns as `members[]`, it produces the
// list of students an instructor can still mark present by hand -- i.e. those
// eligible for attendance who do not already have a `present` record.
//
// Kept DOM-free (like absentees.js) so it can be unit-tested under the
// node-env vitest setup. The <select>/<button> wiring lives in ui.js / app.js.

/**
 * @typedef {Object} SessionMember
 * @property {string} ltiUserId
 * @property {string|null} displayName
 * @property {string|null} institutionalId
 * @property {boolean} eligibleForAttendance
 * @property {{status: string}|null} currentRecord - null when the student has no record yet
 */

/**
 * Filters the session roster snapshot to members who can still be marked
 * present manually: eligible for attendance, and not already `present`.
 * Sorted by `displayName` (case-insensitive; nulls last) for a stable picker.
 *
 * @param {SessionMember[]} members
 * @returns {SessionMember[]}
 */
export function eligibleUnrecordedMembers(members) {
  return (members || [])
    .filter((m) => m.eligibleForAttendance === true && m.currentRecord?.status !== 'present')
    .slice()
    .sort((a, b) => {
      const an = (a.displayName || '').toLocaleLowerCase();
      const bn = (b.displayName || '').toLocaleLowerCase();
      if (an && bn) return an < bn ? -1 : an > bn ? 1 : 0;
      if (an) return -1;
      if (bn) return 1;
      return 0;
    });
}
