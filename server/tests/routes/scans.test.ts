import { Writable } from 'node:stream';
import Fastify from 'fastify';
import { describe, it, expect, vi } from 'vitest';
import { registerScansRoute } from '../../src/routes/scans.js';
import type { IdentityResolution, IdentityResolver } from '../../src/identity/types.js';

function successResolution(overrides: Partial<IdentityResolution> = {}): IdentityResolution {
  return {
    ok: true,
    universityId: '1234567',
    firstName: 'Jane',
    lastName: 'Smith',
    email: 'jane.smith@example.edu',
    raw: {},
    error: null,
    ...overrides,
  };
}

/** A Fastify logger stream that accumulates every log line as a string, for asserting on log content. */
function makeCapturingLogStream() {
  let captured = '';
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      captured += chunk.toString();
      callback();
    },
  });
  return { stream, getCaptured: () => captured };
}

function buildTestApp(resolver: IdentityResolver, logStream?: Writable) {
  const app = Fastify(logStream ? { logger: { level: 'info', stream: logStream } } : { logger: false });
  registerScansRoute(app, resolver);
  return app;
}

describe('POST /api/scans', () => {
  it('returns the resolver result for a valid request', async () => {
    const resolver: IdentityResolver = { resolveCard: vi.fn().mockResolvedValue(successResolution()) };
    const app = buildTestApp(resolver);

    const response = await app.inject({ method: 'POST', url: '/api/scans', payload: { cardCode: 'CARD001' } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(successResolution());
    expect(resolver.resolveCard).toHaveBeenCalledWith('CARD001');
  });

  it('passes through a resolver error result unchanged', async () => {
    const errorResolution: IdentityResolution = {
      ok: false,
      universityId: null,
      firstName: null,
      lastName: null,
      email: null,
      raw: null,
      error: { kind: 'timeout', message: 'Lookup timed out after 5000ms.' },
    };
    const resolver: IdentityResolver = { resolveCard: vi.fn().mockResolvedValue(errorResolution) };
    const app = buildTestApp(resolver);

    const response = await app.inject({ method: 'POST', url: '/api/scans', payload: { cardCode: 'CARD001' } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(errorResolution);
  });

  it('rejects a request with a missing cardCode as 400, without calling the resolver', async () => {
    const resolver: IdentityResolver = { resolveCard: vi.fn() };
    const app = buildTestApp(resolver);

    const response = await app.inject({ method: 'POST', url: '/api/scans', payload: {} });

    expect(response.statusCode).toBe(400);
    expect(resolver.resolveCard).not.toHaveBeenCalled();
  });

  it('rejects a request with an empty-string cardCode as 400', async () => {
    const resolver: IdentityResolver = { resolveCard: vi.fn() };
    const app = buildTestApp(resolver);

    const response = await app.inject({ method: 'POST', url: '/api/scans', payload: { cardCode: '' } });

    expect(response.statusCode).toBe(400);
    expect(resolver.resolveCard).not.toHaveBeenCalled();
  });

  it('never writes the raw card code to the request logger', async () => {
    const resolver: IdentityResolver = { resolveCard: vi.fn().mockResolvedValue(successResolution()) };
    const { stream, getCaptured } = makeCapturingLogStream();
    const app = buildTestApp(resolver, stream);

    const secretCardCode = 'SUPERSECRETCARD42';
    await app.inject({ method: 'POST', url: '/api/scans', payload: { cardCode: secretCardCode } });
    await app.close(); // flushes the pino stream

    expect(getCaptured()).not.toContain(secretCardCode);
  });
});
