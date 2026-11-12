import { pgTable, text, integer, bigint, boolean, jsonb, serial, timestamp, index, date, primaryKey, uniqueIndex } from "drizzle-orm/pg-core";

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

/* =====================================================================
   Student platform tables (added for the student experience)
   ===================================================================== */

// Extra details about each student, shown on their profile and used to pick
// the right timetable. Kept in its own table so the original players table stays untouched.
export const studentDetails = pgTable("student_details", {
  playerId: text("player_id").primaryKey().references(() => players.id, { onDelete: "cascade" }),
  grade: text(),     // e.g. "7"
  section: text(),   // e.g. "A"
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Extra devices a student has linked with a one-time code.
// (The first device's key is stored on the players table as owner_key_hash.)
export const deviceKeys = pgTable("device_keys", {
  keyHash: text("key_hash").primaryKey(),
  playerId: text("player_id").notNull().references(() => players.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Short-lived codes for linking a new device to a student.
export const linkCodes = pgTable("link_codes", {
  codeHash: text("code_hash").primaryKey(),
  playerId: text("player_id").notNull().references(() => players.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

// Achievements are ONLY created by the server, from real activity.
// Students can choose to share one (shared_at), which puts it in the feed.
export const achievements = pgTable("achievements", {
  id: serial().primaryKey(),
  playerId: text("player_id").notNull().references(() => players.id, { onDelete: "cascade" }),
  code: text().notNull(),          // unique per student, stops the same achievement being given twice
  source: text().notNull(),        // "game" | "leaderboard" | "focus" | "challenge" | "milestone"
  title: text().notNull(),
  detail: text().notNull().default(""),
  icon: text().notNull().default("🏅"),
  value: integer(),                // a number to show big on the card (score, minutes...)
  sharedAt: timestamp("shared_at", { withTimezone: true }),
  hidden: boolean().notNull().default(false), // a teacher removed it from the feed
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex("achievements_player_code_idx").on(t.playerId, t.code),
  index("achievements_shared_idx").on(t.sharedAt),
]);

export const cheers = pgTable("cheers", {
  achievementId: integer("achievement_id").notNull().references(() => achievements.id, { onDelete: "cascade" }),
  playerId: text("player_id").notNull().references(() => players.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [primaryKey({ columns: [t.achievementId, t.playerId] })]);

export const comments = pgTable("comments", {
  id: serial().primaryKey(),
  achievementId: integer("achievement_id").notNull().references(() => achievements.id, { onDelete: "cascade" }),
  playerId: text("player_id").notNull().references(() => players.id, { onDelete: "cascade" }),
  body: text().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [index("comments_achievement_idx").on(t.achievementId)]);

// Focus Hub sessions. The server records when a session starts, so a session
// only counts if the full time really passed.
export const focusSessions = pgTable("focus_sessions", {
  id: text().primaryKey(),
  playerId: text("player_id").notNull().references(() => players.id, { onDelete: "cascade" }),
  minutes: integer().notNull(),
  label: text().notNull().default(""),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  completed: boolean().notNull().default(false),
}, t => [index("focus_player_idx").on(t.playerId, t.startedAt)]);

// Weekly class timetable. Empty grade/section means "everyone".
export const classes = pgTable("classes", {
  id: serial().primaryKey(),
  grade: text(),
  section: text(),
  day: integer().notNull(),        // 1 = Monday ... 7 = Sunday
  startTime: text("start_time").notNull(), // "08:00"
  endTime: text("end_time").notNull(),
  subject: text().notNull(),
  teacher: text().notNull().default(""),
  room: text().notNull().default(""),
});

// Tests, assignment deadlines and school dates, all on the calendar.
export const calendarItems = pgTable("calendar_items", {
  id: serial().primaryKey(),
  kind: text().notNull(),          // "test" | "assignment" | "event" | "holiday"
  title: text().notNull(),
  subject: text().notNull().default(""),
  details: text().notNull().default(""),
  date: date({ mode: "string" }).notNull(),
  endDate: date("end_date", { mode: "string" }),
  time: text().notNull().default(""),
  grade: text(),
  section: text(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [index("calendar_date_idx").on(t.date)]);

// A student's own calendar entries. Only they can see them.
export const personalEvents = pgTable("personal_events", {
  id: serial().primaryKey(),
  playerId: text("player_id").notNull().references(() => players.id, { onDelete: "cascade" }),
  title: text().notNull(),
  date: date({ mode: "string" }).notNull(),
  time: text().notNull().default(""),
  note: text().notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [index("personal_player_idx").on(t.playerId)]);

// Assignments a student has ticked off as done (a personal checklist).
export const assignmentDone = pgTable("assignment_done", {
  playerId: text("player_id").notNull().references(() => players.id, { onDelete: "cascade" }),
  itemId: integer("item_id").notNull().references(() => calendarItems.id, { onDelete: "cascade" }),
  doneAt: timestamp("done_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [primaryKey({ columns: [t.playerId, t.itemId] })]);

export const announcements = pgTable("announcements", {
  id: serial().primaryKey(),
  title: text().notNull(),
  body: text().notNull().default(""),
  pinned: boolean().notNull().default(false),
  grade: text(),
  section: text(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Community: school groups and clubs created by teachers that students can join.
export const communities = pgTable("communities", {
  id: serial().primaryKey(),
  name: text().notNull(),
  description: text().notNull().default(""),
  icon: text().notNull().default("👥"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const communityMembers = pgTable("community_members", {
  communityId: integer("community_id").notNull().references(() => communities.id, { onDelete: "cascade" }),
  playerId: text("player_id").notNull().references(() => players.id, { onDelete: "cascade" }),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [primaryKey({ columns: [t.communityId, t.playerId] })]);
