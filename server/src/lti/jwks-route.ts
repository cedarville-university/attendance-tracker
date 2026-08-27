import type { ToolSigningKey } from './signing-keys.js';

export interface JwksResponse {
  keys: Record<string, unknown>[];
}

export function buildJwksResponse(keys: ToolSigningKey[]): JwksResponse {
  return { keys: keys.map((key) => key.publicJwk) };
}
