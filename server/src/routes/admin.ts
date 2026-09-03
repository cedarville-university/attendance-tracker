// server/src/routes/admin.ts
//
// The admin/setup API (Feature 3). Global, not course-scoped: these routes stand up and manage the
// Canvas connection (registration + deployment) and the tool's own LTI signing key. Auth is
// `requireAdmin` (Administrator-role session OR x-setup-token); mutations additionally go through
// CSRF on the session path (`createAdminMutationPreHandlers`).
//
// Errors map to opaque codes + request.id, never an internal Error.message. Audit rows carry ids
// and counts only -- never a private key, never the setup token.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { asc, eq } from 'drizzle-orm';
import type { Database } from '../database/client.js';
import { auditEvents, institutions, ltiDeployments, ltiRegistrations, toolSigningKeys } from '../database/schema.js';
import { rotateSigningKey, type SigningKeyProvider } from '../lti/signing-key-store.js';

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface AdminRouteDeps {
  db: Database;
  requireAdmin: PreHandler;
  adminMutation: PreHandler[];
  signingKeyProvider: SigningKeyProvider;
  appBaseUrl: string;
  /** Re-runs loadSigningKeys after a rotation so the in-memory provider serves the new key. */
  reloadSigningKeys: () => Promise<void>;
}

const upsertRegistrationSchema = z.object({
  institutionSlug: z.string().min(1),
  institutionName: z.string().min(1),
  issuer: z.string().min(1),
  clientId: z.string().min(1),
  oidcAuthEndpoint: z.string().url(),
  tokenEndpoint: z.string().url(),
  tokenAudience: z.string().url().optional(),
  platformJwksUri: z.string().url(),
  deploymentId: z.string().min(1),
});

const toggleSchema = z.object({ enabled: z.boolean() });

type RegistrationView = {
  id: string;
  institution: { slug: string; displayName: string };
  issuer: string;
  clientId: string;
  oidcAuthEndpoint: string;
  tokenEndpoint: string;
  tokenAudience: string;
  platformJwksUri: string;
  enabled: boolean;
  deployments: { id: string; deploymentId: string; enabled: boolean }[];
};

async function listRegistrations(db: Database): Promise<RegistrationView[]> {
  const rows = await db
    .select({
      id: ltiRegistrations.id,
      issuer: ltiRegistrations.issuer,
      clientId: ltiRegistrations.clientId,
      oidcAuthEndpoint: ltiRegistrations.oidcAuthEndpoint,
      tokenEndpoint: ltiRegistrations.tokenEndpoint,
      tokenAudience: ltiRegistrations.tokenAudience,
      platformJwksUri: ltiRegistrations.platformJwksUri,
      enabled: ltiRegistrations.enabled,
      institutionSlug: institutions.slug,
      institutionDisplayName: institutions.displayName,
    })
    .from(ltiRegistrations)
    .innerJoin(institutions, eq(ltiRegistrations.institutionId, institutions.id))
    .orderBy(asc(ltiRegistrations.createdAt));

  const deployments = await db
    .select({
      id: ltiDeployments.id,
      registrationId: ltiDeployments.registrationId,
      deploymentId: ltiDeployments.deploymentId,
      enabled: ltiDeployments.enabled,
    })
    .from(ltiDeployments)
    .orderBy(asc(ltiDeployments.createdAt));

  return rows.map((row) => ({
    id: row.id,
    institution: { slug: row.institutionSlug, displayName: row.institutionDisplayName },
    issuer: row.issuer,
    clientId: row.clientId,
    oidcAuthEndpoint: row.oidcAuthEndpoint,
    tokenEndpoint: row.tokenEndpoint,
    tokenAudience: row.tokenAudience,
    platformJwksUri: row.platformJwksUri,
    enabled: row.enabled,
    deployments: deployments
      .filter((d) => d.registrationId === row.id)
      .map((d) => ({ id: d.id, deploymentId: d.deploymentId, enabled: d.enabled })),
  }));
}

async function signingKeyView(deps: AdminRouteDeps) {
  const keys = deps.signingKeyProvider.list();
  const active = deps.signingKeyProvider.getActive();
  const [row] = await deps.db
    .select({ createdAt: toolSigningKeys.createdAt })
    .from(toolSigningKeys)
    .where(eq(toolSigningKeys.kid, active.kid))
    .limit(1);
  return {
    activeKid: active.kid,
    publicJwk: active.publicJwk,
    // null when the active key comes from LTI_TOOL_SIGNING_KEYS_JSON (no DB row).
    createdAt: row ? row.createdAt.toISOString() : null,
    jwksUrl: `${deps.appBaseUrl}/lti/jwks`,
    previousKids: keys.filter((k) => k.status === 'previous').map((k) => k.kid),
  };
}

export function registerAdminRoutes(app: FastifyInstance, deps: AdminRouteDeps): void {
  const { db } = deps;

  app.get('/api/admin/registrations', { preHandler: deps.requireAdmin }, async () => ({
    registrations: await listRegistrations(db),
  }));

  app.post('/api/admin/registrations', { preHandler: deps.adminMutation }, async (request, reply) => {
    const parsed = upsertRegistrationSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_registration_body', requestId: request.id });
    }
    const input = parsed.data;
    const tokenAudience = input.tokenAudience ?? input.tokenEndpoint;

    const registrationId = await db.transaction(async (tx) => {
      let [institution] = await tx
        .select()
        .from(institutions)
        .where(eq(institutions.slug, input.institutionSlug))
        .limit(1);
      if (!institution) {
        [institution] = await tx
          .insert(institutions)
          .values({ slug: input.institutionSlug, displayName: input.institutionName })
          .returning();
      } else if (institution.displayName !== input.institutionName) {
        await tx
          .update(institutions)
          .set({ displayName: input.institutionName, updatedAt: new Date() })
          .where(eq(institutions.id, institution.id));
      }

      const endpointValues = {
        oidcAuthEndpoint: input.oidcAuthEndpoint,
        tokenEndpoint: input.tokenEndpoint,
        tokenAudience,
        platformJwksUri: input.platformJwksUri,
        updatedAt: new Date(),
      };
      const [registration] = await tx
        .insert(ltiRegistrations)
        .values({
          institutionId: institution.id,
          issuer: input.issuer,
          clientId: input.clientId,
          enabled: true,
          ...endpointValues,
        })
        .onConflictDoUpdate({
          target: [ltiRegistrations.issuer, ltiRegistrations.clientId],
          set: endpointValues,
        })
        .returning();

      await tx
        .insert(ltiDeployments)
        .values({ registrationId: registration.id, deploymentId: input.deploymentId, enabled: true })
        .onConflictDoNothing({ target: [ltiDeployments.registrationId, ltiDeployments.deploymentId] });

      await tx.insert(auditEvents).values({
        institutionId: institution.id,
        actorLtiUserId: request.appSession?.ltiSubject ?? null,
        eventType: 'admin_registration_upserted',
        targetType: 'lti_registration',
        targetId: registration.id,
        newValue: { issuer: input.issuer, clientId: input.clientId, deploymentId: input.deploymentId },
        requestId: request.id,
      });

      return registration.id;
    });

    const all = await listRegistrations(db);
    return { registration: all.find((r) => r.id === registrationId) };
  });

  app.post('/api/admin/registrations/:id/toggle', { preHandler: deps.adminMutation }, async (request, reply) => {
    const parsed = toggleSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_toggle_body', requestId: request.id });
    }
    const { id } = request.params as { id: string };
    const updated = await db
      .update(ltiRegistrations)
      .set({ enabled: parsed.data.enabled, updatedAt: new Date() })
      .where(eq(ltiRegistrations.id, id))
      .returning({ id: ltiRegistrations.id });
    if (updated.length === 0) {
      return reply.code(404).send({ error: 'registration_not_found', requestId: request.id });
    }
    const all = await listRegistrations(db);
    return { registration: all.find((r) => r.id === id) };
  });

  app.get('/api/admin/signing-key', { preHandler: deps.requireAdmin }, async () => signingKeyView(deps));

  app.post('/api/admin/signing-key/rotate', { preHandler: deps.adminMutation }, async (request) => {
    const fresh = await rotateSigningKey(db);
    await deps.reloadSigningKeys();
    // kid only -- never the private key or the setup token (spec §31.8).
    request.log.info({ kid: fresh.kid, reqId: request.id }, 'admin_signing_key_rotated');
    if (request.appSession) {
      await db.insert(auditEvents).values({
        institutionId: request.appSession.institutionId,
        actorLtiUserId: request.appSession.ltiSubject,
        eventType: 'admin_signing_key_rotated',
        targetType: 'tool_signing_key',
        targetId: fresh.kid,
        requestId: request.id,
      });
    }
    return signingKeyView(deps);
  });
}
