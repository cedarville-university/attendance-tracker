import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  // Normalize to the bare origin (scheme + host + port, no path, no trailing
  // slash). Browsers send an `Origin` header with no path, and csrf.ts's
  // verifyOrigin is an exact-string compare -- a configured `https://host/`
  // would 403 every protected mutation. login.ts also concatenates
  // `${appBaseUrl}/lti/launch`, which a trailing slash turns into `//`.
  APP_BASE_URL: z
    .string()
    .url()
    .transform((v) => new URL(v).origin),
  ALLOWED_TARGET_LINK_URIS: z.string().min(1),
  LTI_TOOL_SIGNING_KEYS_JSON: z.string().optional(),
  // Bootstrap credential for the admin/setup page (Feature 3). When unset, the token path is
  // disabled and only an LTI Administrator-role session can reach the admin routes.
  SETUP_TOKEN: z.string().min(16).optional(),
  PORT: z.coerce.number().int().positive().default(3000),
  CLOCK_SKEW_SECONDS: z.coerce.number().int().positive().default(120),
  LOGIN_TRANSACTION_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  APP_SESSION_TTL_HOURS: z.coerce.number().int().positive().default(8),
  NODE_ENV: z.string().optional(),
  // Boot-time schema migration. Unset -> true unless NODE_ENV=production (see refine below).
  // In Azure the runtime image sets NODE_ENV=production, so web/worker never migrate at boot;
  // only the CI migrate job (node dist/migrate.js) touches schema. Local `npm run dev`/`worker`
  // set this true explicitly.
  RUN_MIGRATIONS_ON_BOOT: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  // Optional retention window for maintenance/purge (spec §34). Unset -> retention sweep is a no-op.
  RETENTION_DAYS: z.coerce.number().int().positive().optional(),
});

const withDefaults = envSchema.transform((env) => ({
  ...env,
  RUN_MIGRATIONS_ON_BOOT:
    env.RUN_MIGRATIONS_ON_BOOT ?? env.NODE_ENV !== 'production',
}));

export type Env = z.infer<typeof withDefaults>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = withDefaults.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Invalid environment configuration: ${parsed.error.message}`);
  }
  return parsed.data;
}

export function parseAllowedTargetLinkUris(env: Env): string[] {
  return env.ALLOWED_TARGET_LINK_URIS.split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
