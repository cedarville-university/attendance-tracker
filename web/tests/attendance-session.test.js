import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('../api-client.js', () => ({ apiFetch: vi.fn() }));
import { apiFetch } from '../api-client.js';
import {
  createAttendanceSession,
  closeAttendanceSession,
  reopenAttendanceSession,
  retryGradeSync,
  getAttendanceSession,
  listOpenAttendanceSessions,
  deleteAttendanceRecord,
  correctMemberStatus,
  fetchAttendanceCsv,
  listSessionHistory,
  deleteSession,
  restoreSession,
} from '../attendance-session.js';

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
});

describe('attendance-session.js', () => {
  it('createAttendanceSession POSTs via apiFetch and returns the parsed session on success', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ ok: true, status: 201, json: () => Promise.resolve({ id: 'session-1', state: 'open' }) });

    const result = await createAttendanceSession({ label: 'Monday lecture' });

    expect(apiFetch).toHaveBeenCalledWith('/api/attendance-sessions', expect.objectContaining({ method: 'POST', body: { label: 'Monday lecture' } }));
    expect(result).toEqual({ ok: true, session: { id: 'session-1', state: 'open' } });
  });

  it('createAttendanceSession never throws on a network failure -- returns a normalized error result', async () => {
    vi.mocked(apiFetch).mockRejectedValue(new Error('offline'));
    const result = await createAttendanceSession({});
    expect(result.ok).toBe(false);
    expect(result.error.kind).toBe('network');
  });

  it('createAttendanceSession returns a normalized error result on a non-2xx response', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ ok: false, status: 502, json: () => Promise.resolve({ error: 'roster_unavailable', requestId: 'r1' }) });
    const result = await createAttendanceSession({});
    expect(result.ok).toBe(false);
    expect(result.error.kind).toBe('http-status');
    expect(result.error.message).toContain('502');
  });

  it('closeAttendanceSession POSTs to the close endpoint via apiFetch', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
    const result = await closeAttendanceSession('session-1');
    expect(apiFetch).toHaveBeenCalledWith('/api/attendance-sessions/session-1/close', expect.objectContaining({ method: 'POST' }));
    expect(result.ok).toBe(true);
  });

  it('reopenAttendanceSession POSTs to the reopen endpoint with a reason', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
    await reopenAttendanceSession('session-1', 'Missed a scan');
    expect(apiFetch).toHaveBeenCalledWith('/api/attendance-sessions/session-1/reopen', expect.objectContaining({ method: 'POST', body: { reason: 'Missed a scan' } }));
  });

  it('getAttendanceSession GETs the session by id', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ session: { id: 'session-1', state: 'open' }, members: [] }) });
    const result = await getAttendanceSession('session-1');
    expect(apiFetch).toHaveBeenCalledWith('/api/attendance-sessions/session-1');
    expect(result.ok).toBe(true);
    expect(result.body.session.id).toBe('session-1');
  });

  it('getAttendanceSession passes the whole JSON body through untouched, including a grown gradeSync shape', async () => {
    const gradeSync = {
      state: 'pending',
      counts: { pending: 3, synced: 5, failed: 0 },
      total: 8,
      nextAttemptAt: '2026-08-31T18:05:00.000Z',
      lastSyncedAt: '2026-08-31T17:00:00.000Z',
      lastError: null,
    };
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ session: { id: 'session-1', state: 'closed' }, members: [], gradeSync }),
    });
    const result = await getAttendanceSession('session-1');
    expect(result.ok).toBe(true);
    expect(result.body.gradeSync).toEqual(gradeSync);
  });

  it('listOpenAttendanceSessions GETs the list endpoint and returns the sessions array', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ sessions: [{ id: 's1', state: 'open' }] }) });
    const result = await listOpenAttendanceSessions();
    expect(apiFetch).toHaveBeenCalledWith('/api/attendance-sessions?state=open');
    expect(result).toEqual({ ok: true, sessions: [{ id: 's1', state: 'open' }] });
  });

  it('listOpenAttendanceSessions normalizes a network failure and a missing sessions key', async () => {
    vi.mocked(apiFetch).mockRejectedValueOnce(new Error('offline'));
    const err = await listOpenAttendanceSessions();
    expect(err.ok).toBe(false);
    expect(err.error.kind).toBe('network');

    vi.mocked(apiFetch).mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({}) });
    const empty = await listOpenAttendanceSessions();
    expect(empty).toEqual({ ok: true, sessions: [] });
  });

  it('deleteAttendanceRecord DELETEs the nested record path', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ ok: true, status: 204, json: () => Promise.reject(new Error('no body')) });
    const result = await deleteAttendanceRecord('s1', 'user-1', 'rec-9');
    expect(apiFetch).toHaveBeenCalledWith('/api/attendance-sessions/s1/members/user-1/records/rec-9', expect.objectContaining({ method: 'DELETE' }));
    expect(result.ok).toBe(true);
  });

  it('correctMemberStatus PATCHes the member with the new status and returns the record', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ id: 'rec-10', status: 'excused' }) });
    const result = await correctMemberStatus('s1', 'user-1', 'excused');
    expect(apiFetch).toHaveBeenCalledWith('/api/attendance-sessions/s1/members/user-1', expect.objectContaining({ method: 'PATCH', body: { status: 'excused' } }));
    expect(result).toEqual({ ok: true, record: { id: 'rec-10', status: 'excused' } });
  });

  it('fetchAttendanceCsv GETs export.csv and returns the raw text', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('a,b\r\n1,2') });
    const result = await fetchAttendanceCsv('s1');
    expect(apiFetch).toHaveBeenCalledWith('/api/attendance-sessions/s1/export.csv');
    expect(result.ok).toBe(true);
    expect(result.csv).toBe('a,b\r\n1,2');
  });

  it('fetchAttendanceCsv normalizes a non-2xx response', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ ok: false, status: 404, text: () => Promise.resolve('') });
    const result = await fetchAttendanceCsv('s1');
    expect(result.ok).toBe(false);
    expect(result.error.kind).toBe('http-status');
  });

  it('retryGradeSync POSTs to /grade-sync and returns the retried count on 200', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, retried: 2 }) });
    const result = await retryGradeSync('sess-1');
    expect(apiFetch).toHaveBeenCalledWith('/api/attendance-sessions/sess-1/grade-sync', expect.objectContaining({ method: 'POST' }));
    expect(result).toEqual({ ok: true, retried: 2 });
  });

  it('retryGradeSync surfaces a non-ok response as {ok:false}', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ ok: false, status: 500, json: () => Promise.reject(new Error('not json')) });
    const result = await retryGradeSync('sess-1');
    expect(result.ok).toBe(false);
  });

  it('listSessionHistory GETs the history endpoint and returns the sessions array', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ sessions: [{ id: 's1', state: 'closed' }] }) });
    const result = await listSessionHistory();
    expect(apiFetch).toHaveBeenCalledWith('/api/attendance-sessions/history');
    expect(result).toEqual({ ok: true, sessions: [{ id: 's1', state: 'closed' }] });
  });

  it('listSessionHistory passes ?includeDeleted=1 when asked, and normalizes a missing sessions key', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({}) });
    const result = await listSessionHistory({ includeDeleted: true });
    expect(apiFetch).toHaveBeenCalledWith('/api/attendance-sessions/history?includeDeleted=1');
    expect(result).toEqual({ ok: true, sessions: [] });
  });

  it('listSessionHistory normalizes a network failure', async () => {
    vi.mocked(apiFetch).mockRejectedValueOnce(new Error('offline'));
    const result = await listSessionHistory();
    expect(result.ok).toBe(false);
    expect(result.error.kind).toBe('network');
  });

  it('deleteSession DELETEs the session path and treats 204 (no body) as success', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ ok: true, status: 204, json: () => Promise.reject(new Error('no body')) });
    const result = await deleteSession('s1');
    expect(apiFetch).toHaveBeenCalledWith('/api/attendance-sessions/s1', expect.objectContaining({ method: 'DELETE' }));
    expect(result).toEqual({ ok: true });
  });

  it('deleteSession surfaces a non-2xx as {ok:false}', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ ok: false, status: 404 });
    const result = await deleteSession('s1');
    expect(result.ok).toBe(false);
    expect(result.error.kind).toBe('http-status');
  });

  it('restoreSession POSTs to the restore endpoint', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
    const result = await restoreSession('s1');
    expect(apiFetch).toHaveBeenCalledWith('/api/attendance-sessions/s1/restore', expect.objectContaining({ method: 'POST' }));
    expect(result).toEqual({ ok: true });
  });
});
