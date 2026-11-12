CREATE TABLE "games" (
	"id" text PRIMARY KEY,
	"player_id" text NOT NULL,
	"level" text NOT NULL,
	"questions" jsonb NOT NULL,
	"current" integer DEFAULT 0 NOT NULL,
	"question_started_at" bigint NOT NULL,
	"score" integer DEFAULT 0 NOT NULL,
	"streak" integer DEFAULT 0 NOT NULL,
	"best_streak" integer DEFAULT 0 NOT NULL,
	"correct" integer DEFAULT 0 NOT NULL,
	"finished" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "players" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"avatar_version" bigint,
	"owner_key_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scores" (
	"id" serial PRIMARY KEY,
	"player_id" text NOT NULL,
	"name" text NOT NULL,
	"level" text NOT NULL,
	"score" integer NOT NULL,
	"correct" integer DEFAULT 0 NOT NULL,
	"best_streak" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "scores_level_score_idx" ON "scores" ("level","score");--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_player_id_players_id_fkey" FOREIGN KEY ("player_id") REFERENCES "players"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "scores" ADD CONSTRAINT "scores_player_id_players_id_fkey" FOREIGN KEY ("player_id") REFERENCES "players"("id") ON DELETE CASCADE;