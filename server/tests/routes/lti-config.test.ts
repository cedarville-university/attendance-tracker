import Fastify from 'fastify';
import { describe, it, expect } from 'vitest';
import { registerLtiConfigRoute } from '../../src/routes/lti-config.js';
import { buildCanvasToolConfig } from '../../src/lti/tool-config.js';

const BASE = 'https://attendance.example.edu';

describe('GET /lti/config.json', () => {
  it('serves the Canvas registration body as JSON, unauthenticated', async () => {
    const app = Fastify({ logger: false });
    registerLtiConfigRoute(app, BASE);

    const response = await app.inject({ method: 'GET', url: '/lti/config.json' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/application\/json/);
    expect(response.json()).toEqual(buildCanvasToolConfig(BASE));

    await app.close();
  });

  it('serves the LTI_TOOL_TITLE override when one is configured', async () => {
    const app = Fastify({ logger: false });
    registerLtiConfigRoute(app, BASE, 'Class Check-In');

    const body = (await app.inject({ method: 'GET', url: '/lti/config.json' })).json();

    expect(body.title).toBe('Class Check-In');
    expect(body.extensions[0].settings.placements[0].text).toBe('Class Check-In');

    await app.close();
  });

  it('touches no database', async () => {
    // The route is deliberately dependency-free so it stays as cheap as /health/live and can sit
    // outside the /lti/login + /lti/launch rate-limit scope.
    const app = Fastify({ logger: false });
    registerLtiConfigRoute(app, BASE);

    const response = await app.inject({ method: 'GET', url: '/lti/config.json' });

    expect(response.statusCode).toBe(200);

    await app.close();
  });
});
