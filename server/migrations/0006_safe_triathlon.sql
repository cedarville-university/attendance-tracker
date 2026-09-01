ALTER TABLE "attendance_sessions" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "attendance_sessions" ADD COLUMN "deleted_by_lti_user_id" text;