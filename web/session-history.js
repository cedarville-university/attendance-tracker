// session-history.js
//
// The "Past sessions" panel. Pure view-model builders (buildHistoryView,
// formatOpenedAt) are unit-tested; mountSessionHistory() below is the DOM
// binder and is exercised by the e2e suite, matching ui.js's untested-DOM
// convention. All user-visible strings are written via textContent by the
// caller/renderer, never innerHTML.

/**
 * Human date/time for a session's openedAt / meetingAt.
 * @param {string} iso
 * @param {string} [timeZone] IANA zone; omit to use the viewer's local zone.
 * @returns {string}
 */
export function formatOpenedAt(iso, timeZone) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso ?? '');
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  }).format(d);
}

/**
 * @param {object[]} sessions  serializeSessionHistory() rows from the server (already newest-first)
 * @param {{timeZone?: string, sessionActive?: boolean}} [opts]
 * @returns {{rows: object[], hasDeleted: boolean}}
 */
export function buildHistoryView(sessions, { timeZone, sessionActive = false } = {}) {
  const rows = (sessions ?? []).map((s) => {
    const isDeleted = Boolean(s.deletedAt);
    const enabled = !sessionActive;
    const isOpenish = s.state === 'open' || s.state === 'reopened';
    return {
      id: s.id,
      state: isDeleted ? 'deleted' : s.state,
      openedText: formatOpenedAt(s.openedAt, timeZone),
      labelText: s.label || (s.meetingAt ? formatOpenedAt(s.meetingAt, timeZone) : ''),
      startedByText: s.startedByLtiUserId || '',
      isDeleted,
      actions: {
        resume: { visible: !isDeleted && isOpenish, enabled },
        reopen: { visible: !isDeleted && s.state === 'closed', enabled },
        delete: { visible: !isDeleted, enabled },
        restore: { visible: isDeleted, enabled },
      },
    };
  });
  return { rows, hasDeleted: rows.some((r) => r.isDeleted) };
}
