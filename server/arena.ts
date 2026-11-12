// Math Arena (Game Hub). The server picks the questions, times every answer and
// calculates the score, so scores (and the achievements they unlock) are always earned.
import crypto from "node:crypto";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { players, games, scores } from "../db/schema.js";
import { fail, validId } from "./http.js";
import { avatarUrl, cleanName, findPlayer } from "./players.js";
import { afterArenaRound } from "./achievements.js";

export const LEVELS = ["easy", "medium", "hard"] as const;
const QUESTIONS = 10;
const TIME_MS = 15000;     // time per question
const FEEDBACK_MS = 1100;  // pause after each answer before the next question appears
const GRACE_MS = 1500;     // allowance for network delay

const rnd = (a: number, b: number) => crypto.randomInt(a, b + 1);
function makeQuestion(level: string) {
  let a: number, b: number, op: string;
  if (level === "easy") {
    op = ["+", "−"][rnd(0, 1)];
    a = rnd(1, 20); b = rnd(1, 20);
    if (op === "−" && b > a) [a, b] = [b, a];
  } else if (level === "medium") {
    op = ["+", "−", "×"][rnd(0, 2)];
    if (op === "×") { a = rnd(2, 10); b = rnd(2, 10); }
    else { a = rnd(10, 99); b = rnd(10, 99); if (op === "−" && b > a) [a, b] = [b, a]; }
  } else {
    op = ["×", "÷", "+"][rnd(0, 2)];
    if (op === "×") { a = rnd(6, 15); b = rnd(6, 15); }
    else if (op === "÷") { b = rnd(3, 12); a = b * rnd(3, 12); }
    else { a = rnd(100, 999); b = rnd(100, 999); }
  }
  const ans = op === "+" ? a + b : op === "−" ? a - b : op === "×" ? a * b : a / b;
  return { q: `${a} ${op} ${b}`, ans };
}

// Best score per student, so one student can't fill the whole board.
export async function leaderboard(level: string) {
  if (level !== "all" && !LEVELS.includes(level as any)) fail(400, "Unknown level.");
  const rows = await db
    .select({
      playerId: scores.playerId, name: players.name, level: scores.level, score: scores.score,
      created_at: scores.createdAt, avatarVersion: players.avatarVersion,
    })
    .from(scores)
    .innerJoin(players, eq(players.id, scores.playerId))
    .where(level === "all" ? undefined : eq(scores.level, level))
    .orderBy(desc(scores.score), scores.createdAt)
    .limit(10);
  return rows.map(r => ({
    playerId: r.playerId, name: r.name, level: r.level, score: r.score, created_at: r.created_at,
    avatar: avatarUrl(r.playerId, r.avatarVersion),
  }));
}

export async function start(b: any) {
  const level = String(b.level);
  if (!LEVELS.includes(level as any)) fail(400, "Choose a level.");
  const p = await findPlayer(cleanName(b.name));
  if (!p?.avatarVersion) fail(403, "Take your selfie first.");

  // Tidy up rounds that were started but never finished.
  await db.delete(games).where(lt(games.createdAt, new Date(Date.now() - 24 * 60 * 60 * 1000)));

  const id = crypto.randomUUID();
  const questions = Array.from({ length: QUESTIONS }, () => makeQuestion(level));
  await db.insert(games).values({ id, playerId: p!.id, level, questions, questionStartedAt: Date.now() });
  return { gameId: id, total: QUESTIONS, timeMs: TIME_MS, index: 0, question: questions[0].q };
}

export async function answer(b: any) {
  if (!validId(b.gameId)) fail(400, "Unknown game.");
  const [g] = await db.select().from(games).where(eq(games.id, b.gameId));
  if (!g || g.finished) fail(410, "This round has ended. Start a new one.");

  const now = Date.now();
  const elapsed = Math.max(0, now - g.questionStartedAt);
  const q = g.questions[g.current];
  const value = b.value === null || b.value === "" || b.value === undefined ? null : Number(b.value);
  const inTime = elapsed <= TIME_MS + GRACE_MS;
  const correct = inTime && value !== null && value === q.ans;

  const streak = correct ? g.streak + 1 : 0;
  const left = Math.max(0, 1 - elapsed / TIME_MS);
  const pts = correct ? 100 + Math.round(left * 50) + (streak - 1) * 10 : 0;
  const next = g.current + 1;
  const finished = next >= QUESTIONS;
  const update = {
    current: next,
    questionStartedAt: now + FEEDBACK_MS,
    score: g.score + pts,
    streak,
    bestStreak: Math.max(g.bestStreak, streak),
    correct: g.correct + (correct ? 1 : 0),
    finished,
  };
  // Only accept one answer per question, even if two arrive at once.
  const done = await db.update(games).set(update)
    .where(and(eq(games.id, g.id), eq(games.current, g.current))).returning({ id: games.id });
  if (!done.length) fail(409, "That question was already answered.");

  const reply: any = {
    correct, timedOut: !inTime || value === null, answer: q.ans, pts,
    score: update.score, streak, index: g.current,
  };
  if (!finished) {
    reply.next = { index: next, question: g.questions[next].q };
    return reply;
  }

  const [p] = await db.select().from(players).where(eq(players.id, g.playerId));
  const [saved] = await db.insert(scores).values({
    playerId: g.playerId, name: p?.name || "Player", level: g.level,
    score: update.score, correct: update.correct, bestStreak: update.bestStreak,
  }).returning({ id: scores.id });
  const [{ higher }] = await db.select({ higher: sql<number>`count(*)::int` }).from(scores)
    .where(and(eq(scores.level, g.level), sql`${scores.score} > ${update.score}`));
  await db.delete(games).where(eq(games.id, g.id));
  const result = {
    score: update.score, correct: update.correct, total: QUESTIONS,
    bestStreak: update.bestStreak, level: g.level, rank: higher + 1,
  };
  reply.result = result;
  reply.achievements = await afterArenaRound(g.playerId, { scoreId: saved.id, ...result }).catch(err => {
    console.error("Achievement check failed", err);
    return [];
  });
  return reply;
}

export async function clearScores() {
  await db.delete(scores);
  return { ok: true };
}
