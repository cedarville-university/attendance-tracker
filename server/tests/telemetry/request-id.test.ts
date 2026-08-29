import { describe, it, expect } from 'vitest';
import { genReqId } from '../../src/telemetry/request-id.js';

describe('genReqId', () => {
  it('uses a well-formed inbound x-request-id', () => {
    const req = { headers: { 'x-request-id': 'abc-123' } };
    expect(genReqId(req as never)).toBe('abc-123');
  });
  it('rejects an overlong or unsafe inbound value and falls back to a uuid', () => {
    const req = { headers: { 'x-request-id': 'x'.repeat(200) } };
    const id = genReqId(req as never);
    expect(id).not.toContain('xxxx'.repeat(10));
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });
  it('generates a uuid when no header is present', () => {
    expect(genReqId({ headers: {} } as never)).toMatch(/^[0-9a-f-]{36}$/);
  });
});
