// session-history.js
//
// The "Past sessions" panel. Pure view-model builders (buildHistoryView,
// formatOpenedAt) are unit-tested; mountSessionHistory() below is the DOM
// binder and is exercised by the e2e suite, matching ui.js's untested-DOM
// convention. All user-visible strings are written via textContent by the
// caller/renderer, never innerHTML.

import { bindInlineConfirm } from './confirm-inline.js';
import { listSessionHistory, deleteSession, restoreSession, reopenAttendanceSession } from './attendance-session.js';

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

/**
 * Binds the #session-history-panel. Returns { refresh } so the host (app.js) can
 * re-pull the list after start/close/reopen. Not unit-tested (DOM binder), same
 * convention as ui.js.
 * @param {{
 *   isSessionActive: () => boolean,
 *   attachToServerSession: (sessionId: string, opts?: {announce?: boolean}) => Promise<void>,
 *   showMessage: (kind: string, text: string) => void,
 *   onSessionDeleted?: (sessionId: string) => void,
 *   timeZone?: string,
 * }} deps
 */
export function mountSessionHistory(deps) {
  const panel = document.getElementById('session-history-panel');
  const tbody = document.getElementById('session-history-table-body');
  const emptyMsg = document.getElementById('session-history-empty');
  const statusMsg = document.getElementById('session-history-status');
  const showDeletedToggle = document.getElementById('history-show-deleted');
  const refreshBtn = document.getElementById('btn-refresh-history');
  const rowTemplate = document.getElementById('session-history-row-template');

  let inFlight = false;

  function setStatus(text) {
    if (!text) {
      statusMsg.hidden = true;
      statusMsg.textContent = '';
      return;
    }
    statusMsg.hidden = false;
    statusMsg.textContent = text;
  }

  async function runAction(fn, successText) {
    if (inFlight) return;
    inFlight = true;
    try {
      const result = await fn();
      if (!result.ok) {
        deps.showMessage('error', result.error?.message || 'That action could not be completed.');
        return;
      }
      if (successText) deps.showMessage('info', successText);
      await refresh();
    } finally {
      inFlight = false;
    }
  }

  function renderRow(rowData) {
    const node = rowTemplate.content.firstElementChild.cloneNode(true);
    node.querySelector('.col-opened').textContent = rowData.openedText;
    node.querySelector('.col-label').textContent = rowData.labelText;
    node.querySelector('.col-started-by').textContent = rowData.startedByText;
    const badge = node.querySelector('.status-badge');
    badge.textContent = rowData.state;
    badge.dataset.state = rowData.state;
    if (rowData.isDeleted) node.classList.add('is-deleted');

    const wire = (selector, action, handler) => {
      const btn = node.querySelector(selector);
      btn.hidden = !action.visible;
      btn.disabled = !action.enabled;
      if (action.visible && action.enabled) handler(btn);
    };

    wire('.js-resume', rowData.actions.resume, (btn) => {
      btn.addEventListener('click', () =>
        runAction(async () => {
          await deps.attachToServerSession(rowData.id, { announce: true });
          return { ok: true };
        }),
      );
    });
    wire('.js-reopen', rowData.actions.reopen, (btn) => {
      btn.addEventListener('click', () =>
        runAction(async () => {
          const reopened = await reopenAttendanceSession(rowData.id);
          if (!reopened.ok) return reopened;
          await deps.attachToServerSession(rowData.id, { announce: true });
          return { ok: true };
        }, 'Session reopened. Scans are accepted again.'),
      );
    });
    wire('.js-restore', rowData.actions.restore, (btn) => {
      btn.addEventListener('click', () => runAction(() => restoreSession(rowData.id), 'Session restored.'));
    });
    wire('.js-delete', rowData.actions.delete, (btn) => {
      bindInlineConfirm(btn, {
        armedLabel: 'Click again to delete',
        onConfirm: () =>
          runAction(async () => {
            const result = await deleteSession(rowData.id);
            // Only a genuine successful delete unsticks the main screen; { ok: false }
            // leaves it untouched (runAction still surfaces the error + refreshes).
            if (result.ok) deps.onSessionDeleted?.(rowData.id);
            if (result.ok && result.lastClosedSessionRemoved) {
              deps.showMessage(
                'warning',
                'That was the last closed session in this course. The Canvas attendance column will be removed automatically.',
              );
            }
            return result;
          }, 'Session deleted. You can restore it from “Show deleted”.'),
      });
    });

    return node;
  }

  async function refresh() {
    const result = await listSessionHistory({ includeDeleted: showDeletedToggle.checked });
    if (!result.ok) {
      setStatus('Could not load past sessions.');
      return;
    }
    setStatus('');
    const { rows } = buildHistoryView(result.sessions, {
      timeZone: deps.timeZone,
      sessionActive: deps.isSessionActive(),
    });
    tbody.replaceChildren(...rows.map(renderRow));
    emptyMsg.hidden = rows.length > 0;
  }

  refreshBtn.addEventListener('click', () => {
    refresh();
  });
  showDeletedToggle.addEventListener('change', () => {
    refresh();
  });
  // Refresh when the panel is first expanded so it isn't fetched on every page load.
  panel.addEventListener('toggle', () => {
    if (panel.open) refresh();
  });

  return { refresh };
}
