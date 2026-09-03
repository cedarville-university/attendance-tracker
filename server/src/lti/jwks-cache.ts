export interface JwksCacheDeps {
  fetchJwks(jwksUri: string): Promise<{ keys: Record<string, unknown>[] }>;
}

interface CacheEntry {
  keysByKid: Map<string, Record<string, unknown>>;
}

export class JwksCache {
  private cache = new Map<string, CacheEntry>();

  constructor(private deps: JwksCacheDeps) {}

  async getKey(registrationId: string, jwksUri: string, kid: string): Promise<Record<string, unknown> | null> {
    const cached = this.cache.get(registrationId);
    if (cached?.keysByKid.has(kid)) {
      return cached.keysByKid.get(kid) ?? null;
    }

    const refreshed = await this.fetchAndCache(registrationId, jwksUri);
    return refreshed.keysByKid.get(kid) ?? null;
  }

  private async fetchAndCache(registrationId: string, jwksUri: string): Promise<CacheEntry> {
    const response = await this.deps.fetchJwks(jwksUri);
    const keysByKid = new Map<string, Record<string, unknown>>();
    for (const key of response.keys) {
      if (typeof key.kid === 'string') {
        keysByKid.set(key.kid, key);
      }
    }
    const entry: CacheEntry = { keysByKid };
    this.cache.set(registrationId, entry);
    return entry;
  }
}

export function createDefaultJwksCache(): JwksCache {
  return new JwksCache({
    fetchJwks: async (jwksUri: string) => {
      const response = await fetch(jwksUri);
      if (!response.ok) {
        throw new Error(`Failed to fetch JWKS from ${jwksUri}: HTTP ${response.status}`);
      }
      return (await response.json()) as { keys: Record<string, unknown>[] };
    },
  });
}
