import type { FastifyInstance } from 'fastify';
import { buildCanvasToolConfig } from '../lti/tool-config.js';

// GET /lti/config.json -- the Canvas LTI 1.3 registration body, so an operator can register this
// tool by URL instead of pasting (and mis-substituting) JSON. See lti/tool-config.ts.
//
// Public and unauthenticated by necessity: Canvas fetches this server-side while creating the
// Developer Key, long before any session exists. It exposes nothing sensitive -- public URLs,
// standardized 1EdTech scope URIs, and placement settings. It also does no I/O, which is why it
// sits outside the 30 req/min rate-limit scope that wraps /lti/login and /lti/launch.
// `title` is LTI_TOOL_TITLE; undefined falls back to DEFAULT_TOOL_TITLE.
export function registerLtiConfigRoute(app: FastifyInstance, appBaseUrl: string, title?: string): void {
  app.get('/lti/config.json', async () => buildCanvasToolConfig(appBaseUrl, title));
}
