// Game Hub. The server picks the questions, times every answer and calculates
// the score, so scores (and the achievements they unlock) are always earned.
//  - Math Arena: quick-fire arithmetic.
//  - Pattern Pro: find the next number in a sequence.
import crypto from "node:crypto";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { players, games, scores } from "../db/schema.js";
import { fail, validId } from "./http.js";
import { avatarUrl } from "./players.js";
import { afterArenaRound } from "./achievements.js";
import type { Player } from "./auth.js";

export const LEVELS = ["easy", "medium", "hard"] as const;
export const GAMES = ["arena", "patterns"] as const;
export const GAME_NAME: Record<string, string> = { arena: "Math Arena", patterns: "Pattern Pro" };
const QUESTIONS = 10;
const TIME_MS: Record<string, number> = { arena: 15000, patterns: 20000 }; // time per question
const FEEDBACK_MS = 1100;  // pause after each answer before the next question appears
const GRACE_MS = 1500;     // allowance for network delay

const rnd = (a: number, b: number) => crypto.randomInt(a, b + 1);
const pick = <T>(list: readonly T[]) => list[rnd(0, list.length - 1)];

function arenaQuestion(level: string) {
  let a: number, b: number, op: string;
  if (level === "easy") {
    op = pick(["+", "−"]);
    a = rnd(1, 20); b = rnd(1, 20);
    if (op === "−" && b > a) [a, b] = [b, a];
  } else if (level === "medium") {
    op = pick(["+", "−", "×"]);
    if (op === "×") { a = rnd(2, 10); b = rnd(2, 10); }
    else { a = rnd(10, 99); b = rnd(10, 99); if (op === "−" && b > a) [a, b] = [b, a]; }
  } else {
    op = pick(["×", "÷", "+"]);
    if (op === "×") { a = rnd(6, 15); b = rnd(6, 15); }
    else if (op === "÷") { b = rnd(3, 12); a = b * rnd(3, 12); }
    else { a = rnd(100, 999); b = rnd(100, 999); }
  }
  const ans = op === "+" ? a + b : op === "−" ? a - b : op === "×" ? a * b : a / b;
  return { q: `${a} ${op} ${b}`, ans };
}

// Builds a sequence of numbers and hides the last one.
function patternQuestion(level: string) {
  const kinds = level === "easy" ? ["add", "sub", "add"]
    : level === "medium" ? ["add", "mul", "square", "alt", "sub"]
    : ["mul", "square", "fib", "grow", "alt", "cube"];
  const kind = pick(kinds);
  const seq: number[] = [];
  const len = 5;
  if (kind === "add" || kind === "sub") {
    const step = level === "easy" ? rnd(2, 9) : rnd(6, 19);
    let v = kind === "sub" ? rnd(step * len, step * len + 40) : rnd(1, 30);
    for (let i = 0; i < len; i++) { seq.push(v); v += kind === "sub" ? -step : step; }
  } else if (kind === "mul") {
    const f = level === "hard" ? rnd(2, 4) : 2;
    let v = rnd(1, level === "hard" ? 6 : 5);
    for (let i = 0; i < len; i++) { seq.push(v); v *= f; }
  } else if (kind === "square") {
    const s = rnd(1, level === "hard" ? 9 : 5);
    for (let i = 0; i < len; i++) seq.push((s + i) ** 2);
  } else if (kind === "cube") {
    const s = rnd(1, 3);
    for (let i = 0; i < len; i++) seq.push((s + i) ** 3);
  } else if (kind === "fib") {
    let a = rnd(1, 5), b = rnd(a, a + 6);
    for (let i = 0; i < len; i++) { seq.push(a); [a, b] = [b, a + b]; }
  } else if (kind === "grow") {
    // step grows by one each time: +2, +3, +4...
    let v = rnd(1, 20), step = rnd(1, 5);
    for (let i = 0; i < len; i++) { seq.push(v); v += step; step++; }
  } else {
    // alternating steps: +a, −b, +a, −b ...
    const up = rnd(4, 12), down = rnd(1, up - 1);
    let v = rnd(10, 40);
    for (let i = 0; i < len; i++) { seq.push(v); v += i % 2 === 0 ? up : -down; }
  }
  const ans = seq.pop()!;
  return { q: seq.join(", ") + ", ?", ans };
}

const makeQuestion = (game: string, level: string) => (game === "patterns" ? patternQuestion(level) : arenaQuestion(level));

// Best score per student, so one student can't fill the whole board.
export async function leaderboard(game: string, level: string) {
  if (!GAMES.includes(game as any)) fail(400, "Unknown game.");
  if (level !== "all" && !LEVELS.includes(level as any)) fail(400, "Unknown level.");
  const best = sql<number>`max(${scores.score})::int`;
  const rows = await db
    .select({
      playerId: scores.playerId, name: players.name, avatarVersion: players.avatarVersion,
      score: best,
      level: sql<string>`(array_agg(${scores.level} order by ${scores.score} desc))[1]`,
      created_at: sql<string>`min(${scores.createdAt})`,
    })
    .from(scores)
    .innerJoin(players, eq(players.id, scores.playerId))
    .where(and(eq(scores.game, game), level === "all" ? undefined : eq(scores.level, level)))
    .groupBy(scores.playerId, players.name, players.avatarVersion)
    .orderBy(desc(best), sql`min(${scores.createdAt})`)
    .limit(10);
  return rows.map(r => ({
    playerId: r.playerId, name: r.name, level: r.level, score: r.score, created_at: r.created_at,
    avatar: avatarUrl(r.playerId, r.avatarVersion),
  }));
}

// A student's own best scores and number of rounds per game.
export async function myGameStats(p: Player) {
  const rows = await db.select({
    game: scores.game, level: scores.level,
    best: sql<number>`max(${scores.score})::int`, rounds: sql<number>`count(*)::int`,
  }).from(scores).where(eq(scores.playerId, p.id)).groupBy(scores.game, scores.level);
  return rows;
}

export async function start(p: Player, b: any) {
  const game = String(b.game || "arena");
  const level = String(b.level);
  if (!GAMES.includes(game as any)) fail(400, "Choose a game.");
  if (!LEVELS.includes(level as any)) fail(400, "Choose a level.");

  // Tidy up rounds that were started but never finished.
  await db.delete(games).where(lt(games.createdAt, new Date(Date.now() - 24 * 60 * 60 * 1000)));

  const id = crypto.randomUUID();
  const questions = Array.from({ length: QUESTIONS }, () => makeQuestion(game, level));
  await db.insert(games).values({ id, playerId: p.id, game, level, questions, questionStartedAt: Date.now() });
  return { gameId: id, game, total: QUESTIONS, timeMs: TIME_MS[game], index: 0, question: questions[0].q };
}

export async function answer(p: Player, b: any) {
  if (!validId(b.gameId)) fail(400, "Unknown game.");
  const [g] = await db.select().from(games).where(and(eq(games.id, b.gameId), eq(games.playerId, p.id)));
  if (!g || g.finished) fail(410, "This round has ended. Start a new one.");

  const timeMs = TIME_MS[g.game] || 15000;
  const now = Date.now();
  const elapsed = Math.max(0, now - g.questionStartedAt);
  const q = g.questions[g.current];
  const value = b.value === null || b.value === "" || b.value === undefined ? null : Number(b.value);
  const inTime = elapsed <= timeMs + GRACE_MS;
  const correct = inTime && value !== null && value === q.ans;

  const streak = correct ? g.streak + 1 : 0;
  const left = Math.max(0, 1 - elapsed / timeMs);
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

  const [saved] = await db.insert(scores).values({
    playerId: g.playerId, name: p.name, game: g.game, level: g.level,
    score: update.score, correct: update.correct, bestStreak: update.bestStreak,
  }).returning({ id: scores.id });
  // Rank = 1 + number of OTHER students whose best is higher.
  const [{ higher }] = await db.select({ higher: sql<number>`count(distinct ${scores.playerId})::int` }).from(scores)
    .where(and(eq(scores.game, g.game), eq(scores.level, g.level), sql`${scores.score} > ${update.score}`,
      sql`${scores.playerId} <> ${g.playerId}`));
  await db.delete(games).where(eq(games.id, g.id));
  const result = {
    game: g.game, score: update.score, correct: update.correct, total: QUESTIONS,
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
