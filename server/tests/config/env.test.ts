import { describe, it, expect } from 'vitest';
import { loadEnv, parseAllowedTargetLinkUris } from '../../src/config/env.js';

const BASE_ENV = {
  DATABASE_URL: 'postgres://attendance_tracker:attendance_tracker@localhost:5432/attendance_tracker',
  APP_BASE_URL: 'http://localhost:3000',
  ALLOWED_TARGET_LINK_URIS: 'http://localhost:3000/index.html, http://localhost:3000/scanner.html',
};

describe('loadEnv', () => {
  it('parses required vars and applies defaults for optional ones', () => {
    const env = loadEnv(BASE_ENV);
    expect(env.DATABASE_URL).toBe(BASE_ENV.DATABASE_URL);
    expect(env.CLOCK_SKEW_SECONDS).toBe(120);
    expect(env.LOGIN_TRANSACTION_TTL_SECONDS).toBe(300);
    expect(env.APP_SESSION_TTL_HOURS).toBe(8);
  });

  it('throws when a required var is missing', () => {
    const { DATABASE_URL, ...rest } = BASE_ENV;
    expect(() => loadEnv(rest)).toThrow(/Invalid environment configuration/);
  });

  it('coerces numeric overrides from strings', () => {
    const env = loadEnv({ ...BASE_ENV, CLOCK_SKEW_SECONDS: '60' });
    expect(env.CLOCK_SKEW_SECONDS).toBe(60);
  });
});

describe('parseAllowedTargetLinkUris', () => {
  it('splits, trims, and drops empty entries', () => {
    const env = loadEnv(BASE_ENV);
    expect(parseAllowedTargetLinkUris(env)).toEqual([
      'http://localhost:3000/index.html',
      'http://localhost:3000/scanner.html',
    ]);
  });
});
