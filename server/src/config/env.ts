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
  PORT: z.coerce.number().int().positive().default(3000),
  CLOCK_SKEW_SECONDS: z.coerce.number().int().positive().default(120),
  LOGIN_TRANSACTION_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  APP_SESSION_TTL_HOURS: z.coerce.number().int().positive().default(8),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = envSchema.safeParse(source);
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
