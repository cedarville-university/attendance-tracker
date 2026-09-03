import { describe, it, expect, afterEach } from 'vitest';
import { JwksCache, createDefaultJwksCache } from '../../src/lti/jwks-cache.js';
import { MockCanvasPlatform } from '../support/mock-canvas.js';

describe('JwksCache', () => {
  let platform: MockCanvasPlatform | undefined;

  afterEach(async () => {
    await platform?.stop();
    platform = undefined;
  });

  it('§45 case 12: on an unknown kid, refetches the JWKS once and finds a newly rotated key', async () => {
    platform = new MockCanvasPlatform();
    await platform.start(); // publishes 'default-kid'
    const cache = createDefaultJwksCache();

    // Warm the cache with only 'default-kid' known.
    const initial = await cache.getKey('reg-1', platform.jwksUri, 'default-kid');
    expect(initial).not.toBeNull();

    // Canvas rotates in a brand-new key the cache has never seen.
    await platform.publishNewKey('rotated-kid');

    const rotated = await cache.getKey('reg-1', platform.jwksUri, 'rotated-kid');
    expect(rotated).not.toBeNull();
    expect(rotated?.kid).toBe('rotated-kid');
  });

  it('§45 case 13: on an unknown kid that was never published, fails after one refetch (no infinite retry)', async () => {
    platform = new MockCanvasPlatform();
    await platform.start();
    const cache = createDefaultJwksCache();

    const result = await cache.getKey('reg-1', platform.jwksUri, 'kid-that-does-not-exist');
    expect(result).toBeNull();
  });

  it('does not refetch when the kid is already cached', async () => {
    platform = new MockCanvasPlatform();
    await platform.start();
    let fetchCount = 0;
    const cache = new JwksCache({
      fetchJwks: async (jwksUri) => {
        fetchCount += 1;
        return fetch(jwksUri).then((r) => r.json());
      },
    });

    await cache.getKey('reg-1', platform.jwksUri, 'default-kid');
    await cache.getKey('reg-1', platform.jwksUri, 'default-kid');

    expect(fetchCount).toBe(1);
  });

  it('never falls back to another registration\'s cached keys', async () => {
    platform = new MockCanvasPlatform();
    await platform.start();
    const otherPlatform = new MockCanvasPlatform();
    await otherPlatform.start();
    try {
      const cache = createDefaultJwksCache();
      await cache.getKey('reg-A', platform.jwksUri, 'default-kid');
      await cache.getKey('reg-B', otherPlatform.jwksUri, 'default-kid');

      // reg-A's jwksUri never published 'kid-only-on-b', so looking it up under reg-A's
      // registration ID must fail even though 'kid-only-on-b' genuinely exists on reg-B's platform.
      await otherPlatform.publishNewKey('kid-only-on-b');
      const crossLookup = await cache.getKey('reg-A', platform.jwksUri, 'kid-only-on-b');
      expect(crossLookup).toBeNull();
    } finally {
      await otherPlatform.stop();
    }
  });
});
