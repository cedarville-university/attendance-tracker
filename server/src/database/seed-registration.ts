// server/src/database/seed-registration.ts
//
// Manual-testing CLI: upserts an institution + LTI registration + LTI deployment from the values
// gathered during Canvas Developer Key setup (see docs/canvas-installation.md). Idempotent for the
// institution and deployment rows; running it twice for the same issuer+client_id does NOT update
// an existing registration's endpoints -- delete that row manually first if you need to re-seed it.
//
// For the issuer / oidc-auth-endpoint / token-endpoint / platform-jwks-uri values, use the
// per-environment table in docs/canvas-installation.md §3 -- NOT the account subdomain, and NOT
// `<school>.instructure.com/.well-known/openid-configuration` (that is Canvas's generic API OAuth2
// config, a different protocol from LTI 1.3).
//
// Usage (values shown are the Canvas *test* environment):
//   npx tsx server/src/database/seed-registration.ts \
//     --institution-slug cedarville --institution-name "Cedarville University" \
//     --issuer https://canvas.test.instructure.com --client-id <client-id> \
//     --oidc-auth-endpoint https://sso.test.canvaslms.com/api/lti/authorize_redirect \
//     --token-endpoint https://sso.test.canvaslms.com/login/oauth2/token \
//     --platform-jwks-uri https://sso.test.canvaslms.com/api/lti/security/jwks \
//     --deployment-id <deployment-id>

import { and, eq } from 'drizzle-orm';
import { loadEnv } from '../config/env.js';
import { createDbClient } from './client.js';
import { institutions, ltiRegistrations, ltiDeployments } from './schema.js';

interface SeedArgs {
  institutionSlug: string;
  institutionName: string;
  issuer: string;
  clientId: string;
  oidcAuthEndpoint: string;
  tokenEndpoint: string;
  platformJwksUri: string;
  deploymentId: string;
}

const REQUIRED_FLAGS = [
  'institution-slug',
  'institution-name',
  'issuer',
  'client-id',
  'oidc-auth-endpoint',
  'token-endpoint',
  'platform-jwks-uri',
  'deployment-id',
] as const;

function parseArgs(argv: string[]): SeedArgs {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`Missing value for --${key}`);
      }
      flags.set(key, value);
      i += 1;
    }
  }

  for (const key of REQUIRED_FLAGS) {
    if (!flags.has(key)) {
      throw new Error(`Missing required argument --${key}. See docs/canvas-installation.md for usage.`);
    }
  }

  return {
    institutionSlug: flags.get('institution-slug') as string,
    institutionName: flags.get('institution-name') as string,
    issuer: flags.get('issuer') as string,
    clientId: flags.get('client-id') as string,
    oidcAuthEndpoint: flags.get('oidc-auth-endpoint') as string,
    tokenEndpoint: flags.get('token-endpoint') as string,
    platformJwksUri: flags.get('platform-jwks-uri') as string,
    deploymentId: flags.get('deployment-id') as string,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const env = loadEnv();
  const { db, pool } = createDbClient(env.DATABASE_URL);

  try {
    let [institution] = await db.select().from(institutions).where(eq(institutions.slug, args.institutionSlug)).limit(1);
    if (!institution) {
      [institution] = await db
        .insert(institutions)
        .values({ slug: args.institutionSlug, displayName: args.institutionName, timezone: 'UTC', enabled: true })
        .returning();
      console.log(`Created institution "${args.institutionSlug}" (${institution.id})`);
    } else {
      console.log(`Found existing institution "${args.institutionSlug}" (${institution.id})`);
    }

    let [registration] = await db
      .select()
      .from(ltiRegistrations)
      .where(and(eq(ltiRegistrations.issuer, args.issuer), eq(ltiRegistrations.clientId, args.clientId)))
      .limit(1);
    if (!registration) {
      [registration] = await db
        .insert(ltiRegistrations)
        .values({
          institutionId: institution.id,
          issuer: args.issuer,
          clientId: args.clientId,
          oidcAuthEndpoint: args.oidcAuthEndpoint,
          tokenEndpoint: args.tokenEndpoint,
          tokenAudience: args.tokenEndpoint,
          platformJwksUri: args.platformJwksUri,
          enabled: true,
        })
        .returning();
      console.log(`Created LTI registration for issuer "${args.issuer}" / client "${args.clientId}" (${registration.id})`);
    } else {
      console.log(
        `Found existing LTI registration (${registration.id}) -- endpoints are not updated by this script; ` +
          'delete the row manually first if you need to re-seed it.',
      );
    }

    const [existingDeployment] = await db
      .select()
      .from(ltiDeployments)
      .where(and(eq(ltiDeployments.registrationId, registration.id), eq(ltiDeployments.deploymentId, args.deploymentId)))
      .limit(1);
    if (!existingDeployment) {
      const [deployment] = await db
        .insert(ltiDeployments)
        .values({ registrationId: registration.id, deploymentId: args.deploymentId, enabled: true, configuration: {} })
        .returning();
      console.log(`Created LTI deployment "${args.deploymentId}" (${deployment.id})`);
    } else {
      console.log(`Found existing LTI deployment "${args.deploymentId}" (${existingDeployment.id})`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
