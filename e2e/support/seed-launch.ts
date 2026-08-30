// Thin wrapper over the SERVER's own test support helpers — no new crypto, no new signing logic.
//
//  - MockCanvasPlatform  (server/tests/support/mock-canvas.ts): RSA keypair + JWKS endpoint (the
//    launch route verifies the id_token against registration.platformJwksUri), the
//    client-credentials token endpoint, paginated NRPS, and AGS line-items / scores. It runs an
//    HTTP server on 127.0.0.1:<random>, reachable by BOTH the Playwright-spawned web server and the
//    `node server/dist/worker.js` process.
//  - seedInstitutionAndRegistration (server/tests/support/seed.ts): institution + enabled
//    registration (issuer/jwks/token endpoints pointed at the live mock) + enabled deployment.
//  - platform.mintIdToken(...) mints the instructor id_token; we only supply the nonce from
//    /lti/login and the NRPS/AGS endpoint claims (exactly as
//    server/tests/routes/grade-sync-integration.test.ts does).
//
// Database: E2E_DATABASE_URL (default attendance_tracker_e2e). e2e/support/global-setup.ts CREATEs
// it; the Playwright webServer migrates it at boot (RUN_MIGRATIONS_ON_BOOT=true). Both the web
// server and this helper open the same database.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createDbClient, type DbClient } from '../../server/src/database/client.js';
import { seedInstitutionAndRegistration } from '../../server/tests/support/seed.js';
import { MockCanvasPlatform } from '../../server/tests/support/mock-canvas.js';
import { buildOmnikeyReportBytes } from './webhid-shim.js';

const PORT = 3100;
export const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;
export const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  'postgres://attendance_tracker:attendance_tracker@localhost:5432/attendance_tracker_e2e';
const CARD_FINGERPRINT_SECRET = process.env.E2E_CARD_FINGERPRINT_SECRET ?? 'e2e-secret-not-for-prod';

const INSTRUCTOR_ROLE = 'http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor';
const LEARNER_ROLE = 'http://purl.imsglobal.org/vocab/lis/v2/membership#Learner';
const NRPS_CLAIM = 'https://purl.imsglobal.org/spec/lti-nrps/claim/namesroleservice';
const AGS_CLAIM = 'https://purl.imsglobal.org/spec/lti-ags/claim/endpoint';
const AGS_SCOPES = [
  'https://purl.imsglobal.org/spec/lti-ags/scope/lineitem',
  'https://purl.imsglobal.org/spec/lti-ags/scope/score',
];

// The card code the synthetic scan carries. Must avoid the mock resolver's "ERR" / "NOID"
// sentinels (server/src/identity/mock-resolver.ts).
export const E2E_CARD_CODE = 'E2ECARD001';

// Ported verbatim from server/src/identity/mock-resolver.ts:14-20 + 44-47 so the seeded roster
// learner's institutional id is exactly what MockIdentityResolver.resolveCard(E2E_CARD_CODE)
// returns — that's what makes the scan resolve to "present" instead of "unexpected".
function mockResolverUniversityId(cardCode: string): string {
  let hash = 0;
  for (let i = 0; i < cardCode.length; i += 1) {
    hash = (hash * 31 + cardCode.charCodeAt(i)) >>> 0;
  }
  return String(1000000 + (hash % 9000000));
}

export interface SeededInstructorLaunch {
  /** POST these fields as a form to `launchUrl` from a same-origin document to land the session cookie. */
  launchUrl: string;
  fields: { state: string; id_token: string };
  targetLinkUri: string;
  /** Synthetic scan inputs for window.__emitCard(). */
  cardCode: string;
  cardReportBytes: number[];
  /** The roster learner the scan resolves to. */
  learner: { ltiUserId: string; universityId: string; name: string };
}

let platform: MockCanvasPlatform | undefined;
let dbClient: DbClient | undefined;

function getDb(): DbClient {
  if (!dbClient) dbClient = createDbClient(E2E_DATABASE_URL);
  return dbClient;
}

// Same table set + order as server/tests/support/db.ts resetDb(), so a re-run against a persistent
// e2e database starts clean (seedInstitutionAndRegistration uses a fixed issuer/client_id with a
// UNIQUE constraint). Safe here: workers:1, one spec.
const TRUNCATE_ORDER = [
  'grade_sync_jobs',
  'grade_line_items',
  'attendance_records',
  'attendance_session_members',
  'attendance_sessions',
  'audit_events',
  'course_members',
  'app_sessions',
  'courses',
  'oidc_transactions',
  'lti_deployments',
  'lti_registrations',
  'institutions',
];

async function resetE2eDb(): Promise<void> {
  const { db } = getDb();
  await db.execute(sql.raw(`TRUNCATE TABLE ${TRUNCATE_ORDER.join(', ')} RESTART IDENTITY CASCADE`));
}

async function getPlatform(): Promise<MockCanvasPlatform> {
  if (!platform) {
    platform = new MockCanvasPlatform();
    await platform.start();
  }
  return platform;
}

/**
 * Seeds institution + enabled registration + deployment in the e2e DB, primes the mock Canvas
 * roster with one learner matching E2E_CARD_CODE, drives /lti/login to obtain a fresh (state, nonce),
 * and mints the matching instructor id_token. Returns everything the spec needs to POST the launch.
 */
export async function seedInstructorLaunch(): Promise<SeededInstructorLaunch> {
  const canvas = await getPlatform();
  const { db } = getDb();

  await resetE2eDb();
  const seeded = await seedInstitutionAndRegistration(db, canvas);

  // The mock keys NRPS/AGS state by the path segment we pass here; it does NOT have to equal the
  // DB course row id (the course row is created by the launch from the context claim).
  const contextId = `e2e-course-${randomUUID()}`;
  const learner = {
    ltiUserId: `e2e-learner-${randomUUID()}`,
    universityId: mockResolverUniversityId(E2E_CARD_CODE),
    name: 'E2E Test Learner',
  };
  canvas.setCourseMembers(contextId, [
    {
      user_id: learner.ltiUserId,
      status: 'Active',
      roles: [LEARNER_ROLE],
      name: learner.name,
      lis_person_sourcedid: learner.universityId,
    },
  ]);

  const targetLinkUri = `${BASE_URL}/index.html`;

  // /lti/login -> 302 redirect whose Location carries the freshly-minted state + nonce.
  const loginRes = await fetch(`${BASE_URL}/lti/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    redirect: 'manual',
    body: new URLSearchParams({
      iss: canvas.issuer,
      login_hint: 'e2e-instructor-1',
      target_link_uri: targetLinkUri,
      client_id: seeded.clientId,
      deployment_id: seeded.deploymentId,
    }).toString(),
  });
  if (loginRes.status !== 302) {
    throw new Error(`e2e /lti/login expected 302, got ${loginRes.status}: ${await loginRes.text()}`);
  }
  const location = loginRes.headers.get('location');
  if (!location) throw new Error('e2e /lti/login redirect had no Location header');
  const redirect = new URL(location);
  const state = redirect.searchParams.get('state');
  const nonce = redirect.searchParams.get('nonce');
  if (!state || !nonce) throw new Error(`e2e /lti/login redirect missing state/nonce: ${location}`);

  const idToken = await canvas.mintIdToken({
    nonce,
    sub: 'e2e-instructor-1',
    deploymentId: seeded.deploymentId,
    contextId,
    roles: [INSTRUCTOR_ROLE],
    extraClaims: {
      name: 'E2E Instructor',
      [NRPS_CLAIM]: { context_memberships_url: canvas.nrpsUrlFor(contextId) },
      [AGS_CLAIM]: { lineitems: canvas.lineItemsUrlFor(contextId), scope: AGS_SCOPES },
    },
  });

  return {
    launchUrl: `${BASE_URL}/lti/launch`,
    fields: { state, id_token: idToken },
    targetLinkUri,
    cardCode: E2E_CARD_CODE,
    cardReportBytes: buildOmnikeyReportBytes(E2E_CARD_CODE),
    learner,
  };
}

export interface WorkerRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Spawns `node server/dist/worker.js` once against the e2e DB and resolves when it exits. */
export function runWorkerOnce(): Promise<WorkerRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server/dist/worker.js'], {
      env: {
        ...process.env,
        DATABASE_URL: E2E_DATABASE_URL,
        APP_BASE_URL: BASE_URL,
        ALLOWED_TARGET_LINK_URIS: `${BASE_URL}/index.html`,
        RUN_MIGRATIONS_ON_BOOT: 'false',
        CARD_FINGERPRINT_SECRET,
        LOG_LEVEL: 'silent',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

export interface GradeSyncSummary {
  state: 'none' | 'synced' | 'pending' | 'failed';
  counts: { pending: number; synced: number; failed: number };
  lastError: string | null;
}

/**
 * Reads GET /api/attendance-sessions/:id (needs the session cookie — pass a Playwright request
 * context that shares the browser context's cookies, i.e. `page.request`) and returns its
 * `gradeSync` summary.
 */
export async function readGradeSyncSummary(
  request: { get: (url: string) => Promise<{ ok(): boolean; status(): number; json(): Promise<unknown> }> },
  sessionId: string,
): Promise<GradeSyncSummary> {
  const res = await request.get(`${BASE_URL}/api/attendance-sessions/${sessionId}`);
  if (!res.ok()) throw new Error(`GET /api/attendance-sessions/${sessionId} -> HTTP ${res.status()}`);
  const body = (await res.json()) as { gradeSync: GradeSyncSummary };
  return body.gradeSync;
}

/** Release the mock Canvas HTTP server + the DB pool. Call from the spec's test.afterAll. */
export async function teardownSeedResources(): Promise<void> {
  if (platform) {
    await platform.stop();
    platform = undefined;
  }
  if (dbClient) {
    await dbClient.pool.end();
    dbClient = undefined;
  }
}
