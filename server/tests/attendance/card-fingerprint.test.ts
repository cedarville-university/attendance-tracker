import { describe, it, expect } from 'vitest';
import { computeCardFingerprint } from '../../src/attendance/card-fingerprint.js';

describe('computeCardFingerprint', () => {
  it('is deterministic for the same card code and secret', () => {
    expect(computeCardFingerprint('CARD001', 'secret-a')).toBe(computeCardFingerprint('CARD001', 'secret-a'));
  });

  it('differs for different card codes under the same secret', () => {
    expect(computeCardFingerprint('CARD001', 'secret-a')).not.toBe(computeCardFingerprint('CARD002', 'secret-a'));
  });

  it('differs for the same card code under different secrets (no cross-institution correlation)', () => {
    expect(computeCardFingerprint('CARD001', 'secret-a')).not.toBe(computeCardFingerprint('CARD001', 'secret-b'));
  });

  it('never contains the raw card code as a substring', () => {
    expect(computeCardFingerprint('CARD001', 'secret-a')).not.toContain('CARD001');
  });

  it('returns a 64-character lowercase hex string (SHA-256 digest)', () => {
    const fp = computeCardFingerprint('CARD001', 'secret-a');
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });
});
