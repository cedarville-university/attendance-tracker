CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"course_id" uuid,
	"attendance_session_id" uuid,
	"actor_lti_user_id" text,
	"event_type" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"old_value" jsonb,
	"new_value" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"request_id" text
);
--> statement-breakpoint
CREATE TABLE "course_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"course_id" uuid NOT NULL,
	"lti_user_id" text NOT NULL,
	"institutional_id" text,
	"display_name" text,
	"given_name" text,
	"family_name" text,
	"email" text,
	"roles" jsonb NOT NULL,
	"status" text NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "course_members_course_id_lti_user_id_unique" UNIQUE("course_id","lti_user_id")
);
--> statement-breakpoint
ALTER TABLE "courses" ADD COLUMN "roster_cached_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "institutions" ADD COLUMN "canvas_identity_match_field" text DEFAULT 'lis_person_sourcedid' NOT NULL;--> statement-breakpoint
ALTER TABLE "institutions" ADD COLUMN "identity_match_email_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "institutions" ADD COLUMN "roster_learner_roles" jsonb DEFAULT '["Learner"]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_members" ADD CONSTRAINT "course_members_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE no action ON UPDATE no action;