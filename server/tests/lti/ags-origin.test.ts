// server/tests/lti/ags-origin.test.ts
import { describe, it, expect } from 'vitest';
import { ensureLineItem } from '../../src/lti/ags.js';

const TOKEN = 'test-token';
const ANCHOR = 'https://canvas.test/api/lti/courses/1/line_items';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('ensureLineItem — line-item origin check (backlog 6.1)', () => {
  it('accepts a matched line item whose id is same-origin with the line-items URL', async () => {
    const fetchImpl = (async () =>
      jsonResponse([{ id: `${ANCHOR}/42`, tag: 'attendance', resourceId: 'attendance-cumulative-v1' }])) as typeof fetch;
    const result = await ensureLineItem(ANCHOR, TOKEN, { fetchImpl });
    expect(result.ok).toBe(true);
  });

  it('rejects a matched line item whose id points at a different origin', async () => {
    const fetchImpl = (async () =>
      jsonResponse([
        { id: 'https://evil.test/api/lti/line_items/42', tag: 'attendance', resourceId: 'attendance-cumulative-v1' },
      ])) as typeof fetch;
    const result = await ensureLineItem(ANCHOR, TOKEN, { fetchImpl });
    expect(result).toEqual({
      ok: false,
      error: { kind: 'client-error', message: 'ags:untrusted-lineitem-origin', retryable: false },
    });
  });

  it('rejects a newly-created line item whose id points at a different origin', async () => {
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      if (call === 1) return jsonResponse([]); // no existing match -> triggers create
      return jsonResponse({ id: 'https://evil.test/line_items/99' }, 200); // create response
    }) as typeof fetch;
    const result = await ensureLineItem(ANCHOR, TOKEN, { fetchImpl });
    expect(result).toEqual({
      ok: false,
      error: { kind: 'client-error', message: 'ags:untrusted-lineitem-origin', retryable: false },
    });
  });
});
