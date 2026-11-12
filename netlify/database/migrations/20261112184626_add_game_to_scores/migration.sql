ALTER TABLE "games" ADD COLUMN "game" text DEFAULT 'arena' NOT NULL;--> statement-breakpoint
ALTER TABLE "scores" ADD COLUMN "game" text DEFAULT 'arena' NOT NULL;--> statement-breakpoint
CREATE INDEX "scores_game_level_score_idx" ON "scores" ("game","level","score");--> statement-breakpoint
CREATE INDEX "scores_player_idx" ON "scores" ("player_id","created_at");