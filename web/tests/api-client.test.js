import { vi, describe, it, expect, beforeEach } from 'vitest';
import { bootstrapSession, getCsrfToken, apiFetch } from '../api-client.js';

beforeEach(() => {
  global.fetch = vi.fn();
});

describe('api-client', () => {
  it('bootstrapSession GETs /api/me and caches csrfToken for later apiFetch calls', async () => {
    global.fetch.mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ csrfToken: 'tok-123', course: { id: 'c1' } }) });

    const result = await bootstrapSession();

    expect(global.fetch).toHaveBeenCalledWith('/api/me', expect.objectContaining({ method: 'GET' }));
    expect(result.ok).toBe(true);
    expect(getCsrfToken()).toBe('tok-123');
  });

  it('apiFetch attaches x-csrf-token and a JSON content-type on a mutation', async () => {
    global.fetch.mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ csrfToken: 'tok-123' }) });
    await bootstrapSession();
    global.fetch.mockResolvedValueOnce({ ok: true, status: 201, json: () => Promise.resolve({}) });

    await apiFetch('/api/attendance-sessions', { method: 'POST', body: { label: 'x' } });

    const [, init] = global.fetch.mock.calls.at(-1);
    expect(init.method).toBe('POST');
    expect(init.headers['x-csrf-token']).toBe('tok-123');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.body).toBe(JSON.stringify({ label: 'x' }));
  });

  it('apiFetch leaves a GET untouched (no csrf header, no body)', async () => {
    global.fetch.mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({}) });
    await apiFetch('/api/attendance-sessions/s1');
    const [, init] = global.fetch.mock.calls.at(-1);
    expect(init?.headers?.['x-csrf-token']).toBeUndefined();
    expect(init?.body).toBeUndefined();
  });

  it('bootstrapSession returns a normalized error result on a non-2xx /api/me (never throws)', async () => {
    global.fetch.mockResolvedValueOnce({ ok: false, status: 401, json: () => Promise.resolve({ error: 'unauthenticated' }) });
    const result = await bootstrapSession();
    expect(result.ok).toBe(false);
    expect(result.error.kind).toBe('http-status');
  });
});
