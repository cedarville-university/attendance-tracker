import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('../api-client.js', () => ({ apiFetch: vi.fn() }));
import { apiFetch } from '../api-client.js';
import { createAttendanceSession, closeAttendanceSession, reopenAttendanceSession, getAttendanceSession } from '../attendance-session.js';

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
});
