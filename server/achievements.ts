// Achievements are created here, and only here, from things that really happened
// on the platform (finished Math Arena rounds, completed focus sessions...).
// There is no API that lets a student create or edit one.
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { achievements, focusSessions, scores } from "../db/schema.js";
import { dayKey, weekKey, weekStart } from "./http.js";

type NewAchievement = {
  code: string; source: string; title: string; detail?: string; icon?: string; value?: number | null;
};

export type Achievement = typeof achievements.$inferSelect;

// Saves achievements the student doesn't have yet. Returns only the new ones,
// so the browser can say "You earned something! Share it?".
export async function award(playerId: string, list: NewAchievement[]) {
  if (!list.length) return [];
  const rows = await db.insert(achievements)
    .values(list.map(a => ({ playerId, detail: "", icon: "🏅", value: null, ...a })))
    .onConflictDoNothing()
    .returning();
  return rows.map(publicAchievement);
}

export const publicAchievement = (a: Achievement) => ({
  id: a.id, source: a.source, title: a.title, detail: a.detail, icon: a.icon, value: a.value,
  shared: !!a.sharedAt, sharedAt: a.sharedAt, createdAt: a.createdAt,
});

const LEVEL_NAME: Record<string, string> = { easy: "Easy", medium: "Medium", hard: "Hard" };

/* ===== Weekly challenges =====
   Everyone gets the same challenges each week. Progress is worked out from real activity. */
export const CHALLENGES = [
  { id: "focus-120", icon: "🎯", title: "Focus for 2 hours", detail: "Complete 120 minutes of focus sessions this week.", goal: 120, unit: "min" },
  { id: "arena-5", icon: "🎮", title: "Arena regular", detail: "Finish 5 Math Arena rounds this week.", goal: 5, unit: "rounds" },
  { id: "sharp-8", icon: "🧠", title: "Sharp mind", detail: "Get 8 or more right in a Medium or Hard round.", goal: 1, unit: "round" },
  { id: "focus-days-4", icon: "📅", title: "Steady week", detail: "Focus on 4 different days this week.", goal: 4, unit: "days" },
] as const;

export async function challengeProgress(playerId: string, now = new Date()) {
  const since = weekStart(now);
  const [focus, rounds] = await Promise.all([
    db.select({ minutes: focusSessions.minutes, endedAt: focusSessions.endedAt }).from(focusSessions)
      .where(and(eq(focusSessions.playerId, playerId), eq(focusSessions.completed, true), gte(focusSessions.endedAt, since))),
    db.select({ level: scores.level, correct: scores.correct }).from(scores)
      .where(and(eq(scores.playerId, playerId), gte(scores.createdAt, since))),
  ]);
  const minutes = focus.reduce((t, f) => t + f.minutes, 0);
  const days = new Set(focus.map(f => dayKey(f.endedAt!))).size;
  const sharp = rounds.some(r => r.level !== "easy" && r.correct >= 8) ? 1 : 0;
  const values: Record<string, number> = { "focus-120": minutes, "arena-5": rounds.length, "sharp-8": sharp, "focus-days-4": days };
  return {
    week: weekKey(now),
    challenges: CHALLENGES.map(c => ({ ...c, progress: Math.min(values[c.id], c.goal), done: values[c.id] >= c.goal })),
  };
}

async function challengeAwards(playerId: string) {
  const { week, challenges } = await challengeProgress(playerId);
  return challenges.filter(c => c.done).map(c => ({
    code: `challenge:${c.id}:${week}`, source: "challenge", icon: c.icon,
    title: `Completed the “${c.title}” challenge`, detail: c.detail.replace("this week", `in the week of ${week}`),
  }));
}

/* ===== After a Math Arena round ===== */
export async function afterArenaRound(playerId: string, round: {
  scoreId: number; level: string; score: number; correct: number; total: number; bestStreak: number; rank: number;
}) {
  const lv = LEVEL_NAME[round.level] || round.level;
  const list: NewAchievement[] = [];

  // Personal best for this level (only counts if they had played this level before)
  const [prev] = await db.select({ best: sql<number>`max(${scores.score})::int`, n: sql<number>`count(*)::int` })
    .from(scores).where(and(eq(scores.playerId, playerId), eq(scores.level, round.level), sql`${scores.id} <> ${round.scoreId}`));
  if (prev.n > 0 && round.score > (prev.best || 0)) {
    list.push({ code: `arena-pb:${round.scoreId}`, source: "game", icon: "⚡", value: round.score,
      title: `New personal best in Math Arena (${lv})`, detail: `${round.correct} of ${round.total} correct · best streak ${round.bestStreak}` });
  }
  if (round.correct === round.total) {
    list.push({ code: `arena-perfect:${round.scoreId}`, source: "game", icon: "💯", value: round.score,
      title: `Perfect round in Math Arena (${lv})`, detail: `All ${round.total} questions right` });
  }
  if (round.rank <= 3 && round.score > 0) {
    list.push({ code: `arena-rank:${round.scoreId}`, source: "leaderboard", icon: ["🥇", "🥈", "🥉"][round.rank - 1], value: round.score,
      title: `Reached #${round.rank} on the ${lv} leaderboard`, detail: "Math Arena · Game Hub" });
  }

  // Milestones
  const [{ played }] = await db.select({ played: sql<number>`count(*)::int` }).from(scores).where(eq(scores.playerId, playerId));
  for (const [n, icon] of [[1, "🎮"], [10, "🕹️"], [50, "🏆"], [100, "👑"]] as const) {
    if (played >= n) list.push({ code: `arena-played:${n}`, source: "milestone", icon, value: n,
      title: n === 1 ? "Played a first Math Arena round" : `Played ${n} Math Arena rounds`, detail: "Game Hub milestone" });
  }
  if (round.bestStreak >= 10) {
    list.push({ code: "arena-streak:10", source: "milestone", icon: "🔥", value: 10, title: "10 correct answers in a row", detail: "Math Arena" });
  }

  list.push(...(await challengeAwards(playerId)));
  return award(playerId, list);
}

/* ===== After a focus session ===== */
export async function focusStats(playerId: string) {
  const rows = await db.select({ minutes: focusSessions.minutes, endedAt: focusSessions.endedAt }).from(focusSessions)
    .where(and(eq(focusSessions.playerId, playerId), eq(focusSessions.completed, true)))
    .orderBy(desc(focusSessions.endedAt));
  const totalMinutes = rows.reduce((t, r) => t + r.minutes, 0);
  const days = new Set(rows.map(r => dayKey(r.endedAt!)));
  // Current streak: consecutive days with a focus session, counting back from today (or yesterday).
  let streak = 0;
  const d = new Date();
  if (!days.has(dayKey(d))) d.setTime(d.getTime() - 864e5);
  while (days.has(dayKey(d))) { streak++; d.setTime(d.getTime() - 864e5); }
  // Longest streak ever
  const sorted = [...days].sort();
  let longest = 0, run = 0, prev = "";
  for (const k of sorted) {
    const expected = prev ? new Date(Date.parse(prev) + 864e5).toISOString().slice(0, 10) : "";
    run = k === expected ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = k;
  }
  const today = rows.filter(r => dayKey(r.endedAt!) === dayKey(new Date())).reduce((t, r) => t + r.minutes, 0);
  const longestSession = rows.reduce((m, r) => Math.max(m, r.minutes), 0);
  return { sessions: rows.length, totalMinutes, streak, longestStreak: longest, todayMinutes: today, longestSession, rows };
}

export async function afterFocusSession(playerId: string, session: { id: string; minutes: number; label: string }) {
  const st = await focusStats(playerId);
  const list: NewAchievement[] = [];
  if (st.sessions >= 1) list.push({ code: "focus-first", source: "focus", icon: "🌱", title: "Completed a first focus session", detail: "Focus Hub" });
  if (session.minutes >= 60) list.push({ code: "focus-hour", source: "focus", icon: "⏳", value: session.minutes,
    title: "Focused for a full hour in one session", detail: session.label ? `Working on ${session.label}` : "Focus Hub" });
  for (const h of [1, 5, 10, 25, 50, 100]) {
    if (st.totalMinutes >= h * 60) list.push({ code: `focus-hours:${h}`, source: "focus", icon: h >= 25 ? "🏔️" : "⏱️", value: h,
      title: `${h} hour${h > 1 ? "s" : ""} of total focus time`, detail: "Focus Hub milestone" });
  }
  for (const n of [3, 7, 14, 30]) {
    if (st.streak >= n) list.push({ code: `focus-streak:${n}`, source: "focus", icon: "🔥", value: n,
      title: `${n}-day focus streak`, detail: `Focused ${n} days in a row` });
  }
  for (const n of [10, 50, 100]) {
    if (st.sessions >= n) list.push({ code: `focus-sessions:${n}`, source: "milestone", icon: "🎯", value: n,
      title: `Completed ${n} focus sessions`, detail: "Focus Hub milestone" });
  }
  list.push(...(await challengeAwards(playerId)));
  return award(playerId, list);
}
