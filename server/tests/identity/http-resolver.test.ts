import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HttpIdentityResolver, createHttpIdentityResolverFromEnv } from '../../src/identity/http-resolver.js';

const baseConfig = {
  url: 'https://example.edu/api/ProxId?id={CARD_CODE}&keyname={KEY_NAME}&key={KEY}',
  method: 'GET',
  keyName: 'test-keyname',
  key: 'test-key',
  timeoutMs: 50,
  universityIdField: 'redwoodId',
  firstNameField: 'firstName',
  lastNameField: 'lastName',
  emailField: 'email',
};

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number; statusText?: string } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: init.statusText ?? 'OK',
    json: async () => body,
  } as Response;
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('HttpIdentityResolver', () => {
  it('builds the URL from the template, substituting card code and credentials', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse({ redwoodId: '1234567', firstName: 'Jane', lastName: 'Smith', email: 'jane@example.edu' }));

    const resolver = new HttpIdentityResolver(baseConfig);
    await resolver.resolveCard('CARD 001');

    const requestedUrl = fetchMock.mock.calls[0][0];
    expect(requestedUrl).toBe('https://example.edu/api/ProxId?id=CARD%20001&keyname=test-keyname&key=test-key');
  });

  it('maps a successful JSON response to a normalized identity', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse({ redwoodId: '1234567', firstName: 'Jane', lastName: 'Smith', email: 'jane@example.edu' }));

    const resolver = new HttpIdentityResolver(baseConfig);
    const result = await resolver.resolveCard('CARD001');

    expect(result).toEqual({
      ok: true,
      universityId: '1234567',
      firstName: 'Jane',
      lastName: 'Smith',
      email: 'jane@example.edu',
      raw: { redwoodId: '1234567', firstName: 'Jane', lastName: 'Smith', email: 'jane@example.edu' },
      error: null,
    });
  });

  it('returns a missing-university-id error when the response has no ID field', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse({ firstName: 'Jane' }));

    const resolver = new HttpIdentityResolver(baseConfig);
    const result = await resolver.resolveCard('CARD001');

    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('missing-university-id');
  });

  it('returns an http-status error on a non-ok response', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse({}, { ok: false, status: 500, statusText: 'Internal Server Error' }));

    const resolver = new HttpIdentityResolver(baseConfig);
    const result = await resolver.resolveCard('CARD001');

    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('http-status');
    expect(result.error?.message).toContain('500');
  });

  it('returns a bad-json error when the response body is not valid JSON', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => {
        throw new SyntaxError('Unexpected token');
      },
    } as unknown as Response);

    const resolver = new HttpIdentityResolver(baseConfig);
    const result = await resolver.resolveCard('CARD001');

    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('bad-json');
  });

  it('returns a network error when fetch rejects', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockRejectedValueOnce(new Error('boom'));

    const resolver = new HttpIdentityResolver(baseConfig);
    const result = await resolver.resolveCard('CARD001');

    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('network');
    expect(result.error?.message).toContain('boom');
  });

  it('returns a timeout error when the request exceeds timeoutMs', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementationOnce(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          const signal = (init as RequestInit).signal;
          signal?.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        })
    );

    const resolver = new HttpIdentityResolver(baseConfig);
    const result = await resolver.resolveCard('CARD001');

    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('timeout');
  });
});

describe('createHttpIdentityResolverFromEnv', () => {
  it('returns null when required env vars are unset', () => {
    expect(createHttpIdentityResolverFromEnv({})).toBeNull();
  });

  it('returns a configured resolver when required env vars are set', () => {
    const resolver = createHttpIdentityResolverFromEnv({
      IDENTITY_API_URL: 'https://example.edu/api/ProxId?id={CARD_CODE}',
      IDENTITY_API_KEY_NAME: 'kn',
      IDENTITY_API_KEY: 'k',
    });
    expect(resolver).toBeInstanceOf(HttpIdentityResolver);
  });
});
