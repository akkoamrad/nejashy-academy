CREATE TABLE "achievements" (
	"id" serial PRIMARY KEY,
	"player_id" text NOT NULL,
	"code" text NOT NULL,
	"source" text NOT NULL,
	"title" text NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"icon" text DEFAULT '🏅' NOT NULL,
	"value" integer,
	"shared_at" timestamp with time zone,
	"hidden" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "announcements" (
	"id" serial PRIMARY KEY,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"grade" text,
	"section" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assignment_done" (
	"player_id" text,
	"item_id" integer,
	"done_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assignment_done_pkey" PRIMARY KEY("player_id","item_id")
);
--> statement-breakpoint
CREATE TABLE "calendar_items" (
	"id" serial PRIMARY KEY,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"details" text DEFAULT '' NOT NULL,
	"date" date NOT NULL,
	"end_date" date,
	"time" text DEFAULT '' NOT NULL,
	"grade" text,
	"section" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cheers" (
	"achievement_id" integer,
	"player_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cheers_pkey" PRIMARY KEY("achievement_id","player_id")
);
--> statement-breakpoint
CREATE TABLE "classes" (
	"id" serial PRIMARY KEY,
	"grade" text,
	"section" text,
	"day" integer NOT NULL,
	"start_time" text NOT NULL,
	"end_time" text NOT NULL,
	"subject" text NOT NULL,
	"teacher" text DEFAULT '' NOT NULL,
	"room" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" serial PRIMARY KEY,
	"achievement_id" integer NOT NULL,
	"player_id" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "communities" (
	"id" serial PRIMARY KEY,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"icon" text DEFAULT '👥' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "community_members" (
	"community_id" integer,
	"player_id" text,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "community_members_pkey" PRIMARY KEY("community_id","player_id")
);
--> statement-breakpoint
CREATE TABLE "device_keys" (
	"key_hash" text PRIMARY KEY,
	"player_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "focus_sessions" (
	"id" text PRIMARY KEY,
	"player_id" text NOT NULL,
	"minutes" integer NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"completed" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "link_codes" (
	"code_hash" text PRIMARY KEY,
	"player_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "personal_events" (
	"id" serial PRIMARY KEY,
	"player_id" text NOT NULL,
	"title" text NOT NULL,
	"date" date NOT NULL,
	"time" text DEFAULT '' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "student_details" (
	"player_id" text PRIMARY KEY,
	"grade" text,
	"section" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "achievements_player_code_idx" ON "achievements" ("player_id","code");--> statement-breakpoint
CREATE INDEX "achievements_shared_idx" ON "achievements" ("shared_at");--> statement-breakpoint
CREATE INDEX "calendar_date_idx" ON "calendar_items" ("date");--> statement-breakpoint
CREATE INDEX "comments_achievement_idx" ON "comments" ("achievement_id");--> statement-breakpoint
CREATE INDEX "focus_player_idx" ON "focus_sessions" ("player_id","started_at");--> statement-breakpoint
CREATE INDEX "personal_player_idx" ON "personal_events" ("player_id");--> statement-breakpoint
ALTER TABLE "achievements" ADD CONSTRAINT "achievements_player_id_players_id_fkey" FOREIGN KEY ("player_id") REFERENCES "players"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "assignment_done" ADD CONSTRAINT "assignment_done_player_id_players_id_fkey" FOREIGN KEY ("player_id") REFERENCES "players"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "assignment_done" ADD CONSTRAINT "assignment_done_item_id_calendar_items_id_fkey" FOREIGN KEY ("item_id") REFERENCES "calendar_items"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "cheers" ADD CONSTRAINT "cheers_achievement_id_achievements_id_fkey" FOREIGN KEY ("achievement_id") REFERENCES "achievements"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "cheers" ADD CONSTRAINT "cheers_player_id_players_id_fkey" FOREIGN KEY ("player_id") REFERENCES "players"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_achievement_id_achievements_id_fkey" FOREIGN KEY ("achievement_id") REFERENCES "achievements"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_player_id_players_id_fkey" FOREIGN KEY ("player_id") REFERENCES "players"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "community_members" ADD CONSTRAINT "community_members_community_id_communities_id_fkey" FOREIGN KEY ("community_id") REFERENCES "communities"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "community_members" ADD CONSTRAINT "community_members_player_id_players_id_fkey" FOREIGN KEY ("player_id") REFERENCES "players"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "device_keys" ADD CONSTRAINT "device_keys_player_id_players_id_fkey" FOREIGN KEY ("player_id") REFERENCES "players"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "focus_sessions" ADD CONSTRAINT "focus_sessions_player_id_players_id_fkey" FOREIGN KEY ("player_id") REFERENCES "players"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "link_codes" ADD CONSTRAINT "link_codes_player_id_players_id_fkey" FOREIGN KEY ("player_id") REFERENCES "players"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "personal_events" ADD CONSTRAINT "personal_events_player_id_players_id_fkey" FOREIGN KEY ("player_id") REFERENCES "players"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "student_details" ADD CONSTRAINT "student_details_player_id_players_id_fkey" FOREIGN KEY ("player_id") REFERENCES "players"("id") ON DELETE CASCADE;