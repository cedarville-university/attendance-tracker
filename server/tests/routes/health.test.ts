// server/tests/routes/health.test.ts
import Fastify from 'fastify';
import { describe, it, expect, afterEach } from 'vitest';
import { registerHealthRoutes } from '../../src/routes/health.js';

let app: Awaited<ReturnType<typeof makeApp>>;

async function makeApp(db: unknown) {
  const instance = Fastify({ logger: false });
  registerHealthRoutes(instance, { db: db as never });
  await instance.ready();
  return instance;
}

afterEach(async () => {
  await app?.close();
});

describe('GET /health/live', () => {
  it('returns 200 without touching the database', async () => {
    const db = { execute: () => { throw new Error('db must not be called'); } };
    app = await makeApp(db);
    const res = await app.inject({ method: 'GET', url: '/health/live' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });
});

describe('GET /health/ready', () => {
  it('returns 200 {status:ready} when SELECT 1 succeeds', async () => {
    const db = { execute: async () => ({ rows: [{ '?column?': 1 }] }) };
    app = await makeApp(db);
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ready' });
  });

  it('returns 503 {status:not-ready, checks:{db:false}} when the db check throws', async () => {
    const db = { execute: async () => { throw new Error('connection refused'); } };
    app = await makeApp(db);
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'not-ready', checks: { db: false } });
  });

  it('returns 503 when the db check exceeds the timeout', async () => {
    const db = { execute: () => new Promise(() => {}) }; // never resolves
    app = await makeApp(db);
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(503);
  });
});
