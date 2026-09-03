import { describe, it, expect } from 'vitest';
import { formatOpenedAt, buildHistoryView } from '../session-history.js';

describe('formatOpenedAt', () => {
  it('formats an ISO instant in the given time zone', () => {
    const text = formatOpenedAt('2026-09-01T14:02:00.000Z', 'America/New_York');
    expect(text).toMatch(/Sep 1, 2026/);
    expect(text).toMatch(/10:02/); // 14:02Z == 10:02 EDT
  });

  it('returns the raw value unchanged when it is not a date', () => {
    expect(formatOpenedAt('not-a-date')).toBe('not-a-date');
  });
});

describe('buildHistoryView', () => {
  const base = { id: 's', label: null, meetingAt: null, openedAt: '2026-09-01T14:00:00.000Z', startedByLtiUserId: 'i1', deletedAt: null, deletedByLtiUserId: null };
  const view = (over, opts) => buildHistoryView([{ ...base, ...over }], opts).rows[0];

  it('a closed session offers Reopen + Delete, not Resume/Restore', () => {
    const row = view({ state: 'closed' });
    expect(row.state).toBe('closed');
    expect(row.actions.reopen).toEqual({ visible: true, enabled: true });
    expect(row.actions.delete).toEqual({ visible: true, enabled: true });
    expect(row.actions.resume.visible).toBe(false);
    expect(row.actions.restore.visible).toBe(false);
  });

  it('an open session offers Resume + Delete, not Reopen', () => {
    const row = view({ state: 'open' });
    expect(row.actions.resume.visible).toBe(true);
    expect(row.actions.reopen.visible).toBe(false);
    expect(row.actions.delete.visible).toBe(true);
  });

  it('a reopened session offers Resume', () => {
    expect(view({ state: 'reopened' }).actions.resume.visible).toBe(true);
  });

  it('a soft-deleted session has state "deleted", only Restore visible, and sets hasDeleted', () => {
    const built = buildHistoryView([{ ...base, state: 'closed', deletedAt: '2026-09-02T00:00:00.000Z' }]);
    const row = built.rows[0];
    expect(row.state).toBe('deleted');
    expect(row.isDeleted).toBe(true);
    expect(row.actions.restore).toEqual({ visible: true, enabled: true });
    expect(row.actions.delete.visible).toBe(false);
    expect(row.actions.resume.visible).toBe(false);
    expect(row.actions.reopen.visible).toBe(false);
    expect(built.hasDeleted).toBe(true);
  });

  it('disables every action while a session is active on screen', () => {
    const row = view({ state: 'closed' }, { sessionActive: true });
    expect(row.actions.reopen.enabled).toBe(false);
    expect(row.actions.delete.enabled).toBe(false);
  });

  it('labelText prefers label, then the formatted meetingAt, else empty', () => {
    expect(view({ state: 'open', label: 'Monday lecture' }).labelText).toBe('Monday lecture');
    expect(view({ state: 'open', meetingAt: '2026-09-01T14:00:00.000Z' }, { timeZone: 'UTC' }).labelText).toMatch(/Sep 1, 2026/);
    expect(view({ state: 'open' }).labelText).toBe('');
  });

  it('preserves input order and reports hasDeleted=false when none are deleted', () => {
    const built = buildHistoryView([
      { ...base, id: 'a', state: 'closed' },
      { ...base, id: 'b', state: 'open' },
    ]);
    expect(built.rows.map((r) => r.id)).toEqual(['a', 'b']);
    expect(built.hasDeleted).toBe(false);
  });
});
