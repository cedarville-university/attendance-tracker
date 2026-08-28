import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, boolean, timestamp, jsonb, unique } from 'drizzle-orm/pg-core';

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

export const auditEvents = pgTable('audit_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  institutionId: uuid('institution_id')
    .notNull()
    .references(() => institutions.id),
  courseId: uuid('course_id').references(() => courses.id),
  attendanceSessionId: uuid('attendance_session_id'),
  actorLtiUserId: text('actor_lti_user_id'),
  eventType: text('event_type').notNull(),
  targetType: text('target_type').notNull(),
  targetId: text('target_id').notNull(),
  oldValue: jsonb('old_value'),
  newValue: jsonb('new_value'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  requestId: text('request_id'),
});
