import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, boolean, timestamp, jsonb, integer, doublePrecision, unique, uniqueIndex } from 'drizzle-orm/pg-core';

export const institutions = pgTable('institutions', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  displayName: text('display_name').notNull(),
  timezone: text('timezone').notNull().default('UTC'),
  enabled: boolean('enabled').notNull().default(true),
  canvasIdentityMatchField: text('canvas_identity_match_field').notNull().default('lis_person_sourcedid'),
  identityMatchEmailEnabled: boolean('identity_match_email_enabled').notNull().default(false),
  rosterLearnerRoles: jsonb('roster_learner_roles').$type<string[]>().notNull().default(sql`'["Learner"]'::jsonb`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const ltiRegistrations = pgTable(
  'lti_registrations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id),
    issuer: text('issuer').notNull(),
    clientId: text('client_id').notNull(),
    oidcAuthEndpoint: text('oidc_auth_endpoint').notNull(),
    tokenEndpoint: text('token_endpoint').notNull(),
    tokenAudience: text('token_audience').notNull(),
    platformJwksUri: text('platform_jwks_uri').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.issuer, t.clientId)],
);

export const ltiDeployments = pgTable(
  'lti_deployments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    registrationId: uuid('registration_id')
      .notNull()
      .references(() => ltiRegistrations.id),
    deploymentId: text('deployment_id').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    configuration: jsonb('configuration').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.registrationId, t.deploymentId)],
);

export const oidcTransactions = pgTable(
  'oidc_transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    registrationId: uuid('registration_id')
      .notNull()
      .references(() => ltiRegistrations.id),
    // NOTE: `oidcTransactions.deploymentId` is Canvas's *business* deployment ID (the opaque
    // string Canvas puts in the launch JWT's deployment_id claim), stored as text. It is NOT the
    // `lti_deployments.id` row UUID. `appSessions.deploymentId` below is the opposite: a row UUID
    // FK. Look up one from the other with findDeploymentByBusinessId() (Task 9). Test helpers use
    // the naming precedent `SeededRegistration.deploymentRowId` (Task 11) for the UUID.
    deploymentId: text('deployment_id').notNull(),
    stateHash: text('state_hash').notNull(),
    nonceHash: text('nonce_hash').notNull(),
    targetLinkUri: text('target_link_uri').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
  },
  (t) => [unique().on(t.stateHash)],
);

export const courses = pgTable(
  'courses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id),
    deploymentId: uuid('deployment_id')
      .notNull()
      .references(() => ltiDeployments.id),
    ltiContextId: text('lti_context_id').notNull(),
    label: text('label'),
    title: text('title'),
    nrpsUrl: text('nrps_url'),
    agsLineitemsUrl: text('ags_lineitems_url'),
    lastLaunchedAt: timestamp('last_launched_at', { withTimezone: true }),
    rosterCachedAt: timestamp('roster_cached_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.deploymentId, t.ltiContextId)],
);

export const appSessions = pgTable(
  'app_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionTokenHash: text('session_token_hash').notNull(),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id),
    // NOTE: unlike `oidcTransactions.deploymentId` (Canvas's business deployment ID, text), this
    // column is the `lti_deployments.id` **row UUID** FK. Same property name, different meaning --
    // when wiring the two together always convert explicitly via findDeploymentByBusinessId().
    deploymentId: uuid('deployment_id')
      .notNull()
      .references(() => ltiDeployments.id),
    ltiSubject: text('lti_subject').notNull(),
    displayName: text('display_name'),
    courseId: uuid('course_id')
      .notNull()
      .references(() => courses.id),
    roles: jsonb('roles').notNull(),
    csrfSecret: text('csrf_secret').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [unique().on(t.sessionTokenHash)],
);

export const courseMembers = pgTable(
  'course_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    courseId: uuid('course_id')
      .notNull()
      .references(() => courses.id),
    ltiUserId: text('lti_user_id').notNull(),
    institutionalId: text('institutional_id'),
    displayName: text('display_name'),
    givenName: text('given_name'),
    familyName: text('family_name'),
    email: text('email'),
    roles: jsonb('roles').$type<string[]>().notNull(),
    status: text('status').notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.courseId, t.ltiUserId)],
);

export const attendanceSessions = pgTable('attendance_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  courseId: uuid('course_id').notNull().references(() => courses.id),
  startedByLtiUserId: text('started_by_lti_user_id').notNull(),
  label: text('label'),
  meetingAt: timestamp('meeting_at', { withTimezone: true }),
  openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  state: text('state', { enum: ['open', 'closed', 'reopened'] }).notNull().default('open'),
  rosterSnapshotVersion: integer('roster_snapshot_version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// attendanceSessionMembers -- the roster snapshot; status here is the ROSTER status at
// snapshot time, never the attendance outcome, and is never mutated after insert.
export const attendanceSessionMembers = pgTable('attendance_session_members', {
  id: uuid('id').primaryKey().defaultRandom(),
  attendanceSessionId: uuid('attendance_session_id').notNull().references(() => attendanceSessions.id),
  ltiUserId: text('lti_user_id').notNull(),
  institutionalId: text('institutional_id'),
  displayName: text('display_name'),
  eligibleForAttendance: boolean('eligible_for_attendance').notNull(),
  status: text('status').notNull(), // raw roster status AT SNAPSHOT TIME (e.g. 'Active'/'Inactive')
  snapshotData: jsonb('snapshot_data').notNull(), // a Phase 4 CourseRosterMember, stored verbatim
});

// attendanceRecords -- append-only (with the single documented exception that a
// prior 'lookup_error' row for the same clientScanId is re-resolved and updated
// in place -- see scan-service.ts / spec §47). "Current status" for a member is
// resolved by member-status.ts's resolveCurrentRecord(), never by mutating a row.
export const attendanceRecords = pgTable(
  'attendance_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    attendanceSessionId: uuid('attendance_session_id').notNull().references(() => attendanceSessions.id),
    ltiUserId: text('lti_user_id'),
    institutionalId: text('institutional_id'),
    clientScanId: text('client_scan_id'),
    // 'late' is deliberately omitted -- deferred this phase (settled decision).
    status: text('status', { enum: ['present', 'absent', 'excused', 'lookup_error', 'unexpected'] }).notNull(),
    // Nullable to match spec §26 ("scanned_at nullable"): manual / system_absence
    // rows were never "scanned at" an instant and store null here.
    scannedAt: timestamp('scanned_at', { withTimezone: true }),
    source: text('source', { enum: ['card', 'manual', 'system_absence', 'import'] }).notNull(),
    cardFingerprint: text('card_fingerprint'),
    lookupErrorKind: text('lookup_error_kind'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // Array form -- matches shipped schema.ts (`(t) => [unique().on(...)]`); the
  // object-return form is deprecated by drizzle-kit.
  (table) => [
    // The idempotency mechanism: a retried submission with the same clientScanId
    // never creates a second row. clientScanId is nullable (manual/system_absence
    // records have none), so this constraint only actually de-duplicates 'card' scans.
    uniqueIndex('attendance_records_session_client_scan_id_key').on(table.attendanceSessionId, table.clientScanId),
  ],
);

export const auditEvents = pgTable('audit_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  institutionId: uuid('institution_id')
    .notNull()
    .references(() => institutions.id),
  courseId: uuid('course_id').references(() => courses.id),
  attendanceSessionId: uuid('attendance_session_id').references(() => attendanceSessions.id),
  actorLtiUserId: text('actor_lti_user_id'),
  eventType: text('event_type').notNull(),
  targetType: text('target_type').notNull(),
  targetId: text('target_id').notNull(),
  oldValue: jsonb('old_value'),
  newValue: jsonb('new_value'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  requestId: text('request_id'),
});

export type AttendanceSessionRow = typeof attendanceSessions.$inferSelect;
export type AttendanceSessionMemberRow = typeof attendanceSessionMembers.$inferSelect;
export type AttendanceRecordRow = typeof attendanceRecords.$inferSelect;

// One cumulative Canvas Gradebook line item per course (spec §27). UNIQUE(course_id) makes
// ensureLineItem's persist step idempotent regardless of how many times the worker runs.
export const gradeLineItems = pgTable(
  'grade_line_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    courseId: uuid('course_id').notNull().references(() => courses.id),
    canvasLineItemId: text('canvas_line_item_id').notNull(),
    canvasLineItemUrl: text('canvas_line_item_url').notNull(),
    resourceId: text('resource_id').notNull(),
    tag: text('tag').notNull(),
    scoreMaximum: integer('score_maximum').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.courseId)],
);

// Durable grade-sync outbox (spec §28). One row per (course, member): each session close upserts
// the member's latest cumulative score and resets the row to pending. state: pending -> synced on a
// successful AGS post; pending -> failed after MAX_GRADE_SYNC_ATTEMPTS retries or a permanent 4xx.
// (the `enum` on the state column narrows the TS type only — Postgres stores plain text with no CHECK
// constraint, same as attendance_records.status / attendance_sessions.state.)
export const gradeSyncJobs = pgTable(
  'grade_sync_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    courseId: uuid('course_id').notNull().references(() => courses.id),
    // The session whose close last (re)computed this score. Nullable per spec §26; a manual retry
    // (POST /grade-sync) leaves it unchanged.
    attendanceSessionId: uuid('attendance_session_id').references(() => attendanceSessions.id),
    ltiUserId: text('lti_user_id').notNull(),
    // Cumulative percentage 0..100 (scoreGiven; maximum is 100). doublePrecision (float8) on purpose:
    // `real` (float4) has ~7 significant digits and would lose the 4th decimal of e.g. 33.3333, and
    // `numeric` comes back from node-postgres as a STRING, which would break every toBeCloseTo and
    // force a Number() wrapper in grade-worker.ts. Do not "improve" this to numeric.
    score: doublePrecision('score').notNull(),
    state: text('state', { enum: ['pending', 'synced', 'failed'] }).notNull().default('pending'),
    attemptCount: integer('attempt_count').notNull().default(0),
    lastError: text('last_error'), // opaque short code only (spec §31.9) — never a raw Canvas body
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.courseId, t.ltiUserId)],
);

export type GradeLineItemRow = typeof gradeLineItems.$inferSelect;
export type GradeSyncJobRow = typeof gradeSyncJobs.$inferSelect;

// The tool's own LTI signing keypairs (Feature 3 / admin setup). DB-backed so `/lti/jwks` and the
// `client_assertion` `kid` stay stable across restarts in dev, and so an admin can rotate the key
// from the setup page. Precedence: `LTI_TOOL_SIGNING_KEYS_JSON` (prod) wins over this table; an
// empty table is populated with one generated `active` row on first boot.
//
// DEV ONLY as written: `private_key_pkcs8_pem` is stored in plaintext. Production MUST instead
// supply `LTI_TOOL_SIGNING_KEYS_JSON` (env / secret store) or encrypt this column at rest.
// (`enum` on `status` narrows the TS type only — Postgres stores plain text, like grade_sync_jobs.state.)
export const toolSigningKeys = pgTable(
  'tool_signing_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kid: text('kid').notNull().unique(),
    status: text('status', { enum: ['active', 'previous'] }).notNull(),
    privateKeyPkcs8Pem: text('private_key_pkcs8_pem').notNull(),
    publicJwk: jsonb('public_jwk').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // Partial unique index: at most one row may be `active` at a time.
  (t) => [uniqueIndex('tool_signing_keys_one_active').on(t.status).where(sql`${t.status} = 'active'`)],
);

export type ToolSigningKeyRow = typeof toolSigningKeys.$inferSelect;
