import { describe, it, expect } from 'vitest';
import { MockIdentityResolver } from '../../src/identity/mock-resolver.js';

describe('MockIdentityResolver', () => {
  it('resolves the same card code to the same deterministic identity every time', async () => {
    const resolver = new MockIdentityResolver();
    const first = await resolver.resolveCard('CARD001');
    const second = await resolver.resolveCard('CARD001');

    expect(first.ok).toBe(true);
    expect(first).toEqual(second);
    expect(first.universityId).toMatch(/^\d+$/);
    expect(first.firstName).toBeTruthy();
    expect(first.lastName).toBeTruthy();
    expect(first.email).toContain('@example.edu');
  });

  it('resolves different card codes to different identities', async () => {
    const resolver = new MockIdentityResolver();
    const a = await resolver.resolveCard('CARD_A');
    const b = await resolver.resolveCard('CARD_B');

    expect(a.universityId).not.toBe(b.universityId);
  });

  it('simulates a network failure when the card code contains "ERR"', async () => {
    const resolver = new MockIdentityResolver();
    const result = await resolver.resolveCard('SOMEERRCODE');

    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('network');
    expect(result.universityId).toBeNull();
  });

  it('simulates a missing University ID when the card code contains "NOID"', async () => {
    const resolver = new MockIdentityResolver();
    const result = await resolver.resolveCard('SOMENOIDCODE');

    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('missing-university-id');
  });

  it('matches the ERR/NOID sentinels case-insensitively', async () => {
    const resolver = new MockIdentityResolver();
    const errResult = await resolver.resolveCard('err123');
    const noidResult = await resolver.resolveCard('noid456');

    expect(errResult.error?.kind).toBe('network');
    expect(noidResult.error?.kind).toBe('missing-university-id');
  });
});
