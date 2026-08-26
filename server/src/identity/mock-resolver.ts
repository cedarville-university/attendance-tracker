// mock-resolver.ts
//
// Deterministic, network-free identity resolver -- ported verbatim (hash
// algorithm, name lists, ERR/NOID sentinels) from the mockLookup() adapter
// formerly in web/lookup.js, so existing dev/demo behavior is unchanged now
// that resolution happens server-side. See docs/canvas-lti/progress.md for
// why this stays the default resolver through Phase 2.

import type { IdentityErrorKind, IdentityResolution, IdentityResolver } from './types.js';

const MOCK_FIRST_NAMES = ['Jane', 'Alex', 'Sam', 'Taylor', 'Jordan', 'Morgan', 'Casey', 'Riley'];
const MOCK_LAST_NAMES = ['Smith', 'Johnson', 'Lee', 'Garcia', 'Brown', 'Davis', 'Miller', 'Wilson'];

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorResult(kind: IdentityErrorKind, message: string, raw: unknown = null): IdentityResolution {
  return { ok: false, universityId: null, firstName: null, lastName: null, email: null, raw, error: { kind, message } };
}

export class MockIdentityResolver implements IdentityResolver {
  async resolveCard(cardCode: string): Promise<IdentityResolution> {
    await delay(150 + Math.floor(Math.random() * 750));

    const upperCode = cardCode.toUpperCase();
    if (upperCode.includes('ERR')) {
      return errorResult('network', 'Simulated network failure (mock adapter: card code contains "ERR").');
    }
    if (upperCode.includes('NOID')) {
      return errorResult('missing-university-id', 'Simulated missing University ID (mock adapter: card code contains "NOID").', {
        note: 'mock response intentionally omitted universityId',
      });
    }

    const hash = hashString(cardCode);
    const firstName = MOCK_FIRST_NAMES[hash % MOCK_FIRST_NAMES.length];
    const lastName = MOCK_LAST_NAMES[Math.floor(hash / MOCK_FIRST_NAMES.length) % MOCK_LAST_NAMES.length];
    const universityId = String(1000000 + (hash % 9000000));
    const email = `${firstName}.${lastName}${universityId.slice(-3)}@example.edu`.toLowerCase();

    const raw = { universityId, firstName, lastName, email, mock: true };
    return { ok: true, universityId, firstName, lastName, email, raw, error: null };
  }
}
