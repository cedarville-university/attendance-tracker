// scans.ts
//
// POST /api/scans -- the backend counterpart to the browser's former
// direct lookupCard() call. Validates the request body, resolves the card
// via whichever IdentityResolver the server was configured with, and
// returns the normalized result. Stateless: no session/persistence yet
// (that's Phase 5).
//
// The raw card code must never be logged server-side (see spec §22).
// Fastify's default request/response logging only records method, url,
// status code, and timing -- never the body -- so as long as nothing in
// this handler explicitly logs `request.body` or `cardCode`, that
// guarantee holds. Keep it that way.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { IdentityResolver } from '../identity/types.js';

const scanRequestSchema = z.object({
  cardCode: z.string().min(1),
});

export function registerScansRoute(app: FastifyInstance, resolver: IdentityResolver): void {
  app.post('/api/scans', async (request, reply) => {
    const parsed = scanRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request body: expected { cardCode: string }.' });
    }

    const result = await resolver.resolveCard(parsed.data.cardCode);
    return result;
  });
}
