ALTER TABLE "grade_line_items" ADD COLUMN "delete_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "grade_line_items" ADD COLUMN "delete_requested_by_lti_user_id" text;--> statement-breakpoint
ALTER TABLE "grade_line_items" ADD COLUMN "delete_attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "grade_line_items" ADD COLUMN "delete_next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "grade_line_items" ADD COLUMN "delete_last_error" text;