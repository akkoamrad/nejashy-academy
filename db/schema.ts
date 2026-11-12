import { pgTable, text, integer, bigint, boolean, jsonb, serial, timestamp, index } from "drizzle-orm/pg-core";

// A student's player profile. One per name (case-insensitive).
export const players = pgTable("players", {
  id: text().primaryKey(),                                   // hash of the lower-cased name
  name: text().notNull(),
  avatarVersion: bigint("avatar_version", { mode: "number" }), // null = no selfie yet (or reset by a teacher)
  ownerKeyHash: text("owner_key_hash"),                       // lets the student's own device change their photo
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// A Math Arena round in progress. The server keeps the answers and the timing,
// so scores are always earned by actually playing.
export const games = pgTable("games", {
  id: text().primaryKey(),
  playerId: text("player_id").notNull().references(() => players.id, { onDelete: "cascade" }),
  level: text().notNull(),
  questions: jsonb().$type<{ q: string; ans: number }[]>().notNull(),
  current: integer().notNull().default(0),
  questionStartedAt: bigint("question_started_at", { mode: "number" }).notNull(),
  score: integer().notNull().default(0),
  streak: integer().notNull().default(0),
  bestStreak: integer("best_streak").notNull().default(0),
  correct: integer().notNull().default(0),
  finished: boolean().notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Finished rounds, used for the leaderboard.
export const scores = pgTable("scores", {
  id: serial().primaryKey(),
  playerId: text("player_id").notNull().references(() => players.id, { onDelete: "cascade" }),
  name: text().notNull(),
  level: text().notNull(),
  score: integer().notNull(),
  correct: integer().notNull().default(0),
  bestStreak: integer("best_streak").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [index("scores_level_score_idx").on(t.level, t.score)]);
