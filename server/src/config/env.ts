import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  APP_BASE_URL: z.string().url(),
  ALLOWED_TARGET_LINK_URIS: z.string().min(1),
  LTI_TOOL_SIGNING_KEYS_JSON: z.string().optional(),
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
