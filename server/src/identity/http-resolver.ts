// http-resolver.ts
//
// Real fetch-based identity resolver -- ported verbatim (AbortController
// timeout, HTTP-status check, JSON-parse check, missing-ID check) from the
// realLookup() adapter formerly in web/lookup.js. The credentials and URL
// template that used to come from the browser's "Card Lookup API
// Credentials" panel (credentials.js) and config.js now come from server
// environment variables instead, so no secret ever reaches the browser.
//
// Not wired to real Cedarville ProxID values in this pass -- see
// docs/canvas-lti/progress.md's "Deferred decisions" section for the
// required env vars. `createHttpIdentityResolverFromEnv()` returns `null`
// when they're unset, so the caller can fall back to MockIdentityResolver.

import type { IdentityErrorKind, IdentityResolution, IdentityResolver } from './types.js';

export interface HttpIdentityResolverConfig {
  /** May contain the literal placeholders {CARD_CODE}, {KEY_NAME}, {KEY}. */
  url: string;
  method: string;
  keyName: string;
  key: string;
  timeoutMs: number;
  /** Field name or dot-path (e.g. "student.universityId") read out of the raw JSON response. */
  universityIdField: string;
  firstNameField: string;
  lastNameField: string;
  emailField: string;
}

function getByPath(obj: unknown, path: string): unknown {
  if (obj == null || !path) return undefined;
  return path.split('.').reduce<unknown>((value, key) => {
    if (value == null || typeof value !== 'object') return undefined;
    return (value as Record<string, unknown>)[key];
  }, obj);
}

interface NormalizedFields {
  universityId: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
}

function errorResult(kind: IdentityErrorKind, message: string, raw: unknown = null): IdentityResolution {
  return { ok: false, universityId: null, firstName: null, lastName: null, email: null, raw, error: { kind, message } };
}

function successResult(normalized: NormalizedFields, raw: unknown): IdentityResolution {
  return { ok: true, ...normalized, raw, error: null };
}

type ApiRequestResult = { ok: true; json: unknown } | { ok: false; errorKind: IdentityErrorKind; message: string };

export class HttpIdentityResolver implements IdentityResolver {
  constructor(private readonly config: HttpIdentityResolverConfig) {}

  private mapRawResponseToNormalized(rawJson: unknown): NormalizedFields {
    const rawUniversityId = getByPath(rawJson, this.config.universityIdField);
    return {
      universityId: rawUniversityId == null ? null : String(rawUniversityId).trim(),
      firstName: (getByPath(rawJson, this.config.firstNameField) as string | null) ?? null,
      lastName: (getByPath(rawJson, this.config.lastNameField) as string | null) ?? null,
      email: (getByPath(rawJson, this.config.emailField) as string | null) ?? null,
    };
  }

  private async performApiRequest(url: string): Promise<ApiRequestResult> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        method: this.config.method,
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof Error && err.name === 'AbortError') {
        return { ok: false, errorKind: 'timeout', message: `Lookup timed out after ${this.config.timeoutMs}ms.` };
      }
      return { ok: false, errorKind: 'network', message: `Lookup failed: ${message}` };
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      return { ok: false, errorKind: 'http-status', message: `Lookup API returned HTTP ${response.status} ${response.statusText}` };
    }

    try {
      const json = await response.json();
      return { ok: true, json };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, errorKind: 'bad-json', message: `Lookup API returned a response that was not valid JSON: ${message}` };
    }
  }

  private finalizeLookup(json: unknown): IdentityResolution {
    const normalized = this.mapRawResponseToNormalized(json);
    if (!normalized.universityId) {
      return errorResult('missing-university-id', 'Lookup API response did not include a University ID.', json);
    }
    return successResult(normalized, json);
  }

  async resolveCard(cardCode: string): Promise<IdentityResolution> {
    const url = this.config.url
      .replace('{CARD_CODE}', encodeURIComponent(cardCode))
      .replace('{KEY_NAME}', encodeURIComponent(this.config.keyName))
      .replace('{KEY}', encodeURIComponent(this.config.key));

    const requestResult = await this.performApiRequest(url);
    if (!requestResult.ok) {
      return errorResult(requestResult.errorKind, requestResult.message);
    }
    return this.finalizeLookup(requestResult.json);
  }
}

/**
 * Builds an HttpIdentityResolver from environment variables, or returns
 * `null` if the required ones aren't set. Required: IDENTITY_API_URL,
 * IDENTITY_API_KEY_NAME, IDENTITY_API_KEY. See
 * docs/canvas-lti/progress.md for the full list and defaults.
 */
export function createHttpIdentityResolverFromEnv(env: NodeJS.ProcessEnv = process.env): HttpIdentityResolver | null {
  const url = env.IDENTITY_API_URL;
  const keyName = env.IDENTITY_API_KEY_NAME;
  const key = env.IDENTITY_API_KEY;
  if (!url || !keyName || !key) return null;

  return new HttpIdentityResolver({
    url,
    method: env.IDENTITY_API_METHOD || 'GET',
    keyName,
    key,
    timeoutMs: Number(env.IDENTITY_API_TIMEOUT_MS) || 5000,
    universityIdField: env.IDENTITY_API_UNIVERSITY_ID_FIELD || 'redwoodId',
    firstNameField: env.IDENTITY_API_FIRST_NAME_FIELD || 'firstName',
    lastNameField: env.IDENTITY_API_LAST_NAME_FIELD || 'lastName',
    emailField: env.IDENTITY_API_EMAIL_FIELD || 'email',
  });
}
