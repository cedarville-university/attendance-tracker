CREATE TABLE "grade_line_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"course_id" uuid NOT NULL,
	"canvas_line_item_id" text NOT NULL,
	"canvas_line_item_url" text NOT NULL,
	"resource_id" text NOT NULL,
	"tag" text NOT NULL,
	"score_maximum" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grade_line_items_course_id_unique" UNIQUE("course_id")
);
--> statement-breakpoint
CREATE TABLE "grade_sync_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"course_id" uuid NOT NULL,
	"attendance_session_id" uuid,
	"lti_user_id" text NOT NULL,
	"score" double precision NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grade_sync_jobs_course_id_lti_user_id_unique" UNIQUE("course_id","lti_user_id")
);
--> statement-breakpoint
ALTER TABLE "grade_line_items" ADD CONSTRAINT "grade_line_items_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grade_sync_jobs" ADD CONSTRAINT "grade_sync_jobs_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grade_sync_jobs" ADD CONSTRAINT "grade_sync_jobs_attendance_session_id_attendance_sessions_id_fk" FOREIGN KEY ("attendance_session_id") REFERENCES "public"."attendance_sessions"("id") ON DELETE no action ON UPDATE no action;