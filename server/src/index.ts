import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { registerScansRoute } from './routes/scans.js';
import { MockIdentityResolver } from './identity/mock-resolver.js';
import { createHttpIdentityResolverFromEnv } from './identity/http-resolver.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, '../../web');

const app = Fastify({ logger: true });

app.register(fastifyStatic, {
  root: webRoot,
});

app.get('/health', async () => ({ status: 'ok' }));

// Falls back to the Mock resolver whenever the real HTTP resolver's
// required env vars aren't set -- see docs/canvas-lti/progress.md's
// "Deferred decisions" section for why that's the case through Phase 2.
const identityResolver = createHttpIdentityResolverFromEnv() ?? new MockIdentityResolver();
registerScansRoute(app, identityResolver);

const port = Number(process.env.PORT ?? 3000);
app.listen({ port, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
