// server/tests/support/seed.ts
import { randomUUID } from 'node:crypto';
import type { Database } from '../../src/database/client.js';
import { institutions, ltiRegistrations, ltiDeployments } from '../../src/database/schema.js';
import type { MockCanvasPlatform } from './mock-canvas.js';

export interface SeededRegistration {
  institutionId: string;
  registrationId: string;
  deploymentRowId: string;
  clientId: string;
  deploymentId: string;
}

export interface SeedOverrides {
  clientId?: string;
  deploymentId?: string;
}

export async function seedInstitutionAndRegistration(
  db: Database,
  platform: MockCanvasPlatform,
  overrides: SeedOverrides = {},
): Promise<SeededRegistration> {
  const clientId = overrides.clientId ?? 'mock-client-id';
  const deploymentId = overrides.deploymentId ?? 'mock-deployment-1';

  const [institution] = await db
    .insert(institutions)
    .values({ slug: `mock-${randomUUID()}`, displayName: 'Mock University', timezone: 'UTC', enabled: true })
    .returning();

  const [registration] = await db
    .insert(ltiRegistrations)
    .values({
      institutionId: institution.id,
      issuer: platform.issuer,
      clientId,
      oidcAuthEndpoint: 'https://mock-canvas.test/api/lti/authorize_redirect',
      tokenEndpoint: 'https://mock-canvas.test/login/oauth2/token',
      tokenAudience: 'https://mock-canvas.test/login/oauth2/token',
      platformJwksUri: platform.jwksUri,
      enabled: true,
    })
    .returning();

  const [deployment] = await db
    .insert(ltiDeployments)
    .values({ registrationId: registration.id, deploymentId, enabled: true, configuration: {} })
    .returning();

  return { institutionId: institution.id, registrationId: registration.id, deploymentRowId: deployment.id, clientId, deploymentId };
}
