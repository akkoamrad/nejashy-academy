// The achievement feed. Students can only share achievements the server created
// for them; everything here is about showing, sharing, cheering and commenting.
import { and, desc, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { achievements, cheers, comments, communityMembers, players, studentDetails, focusSessions, scores } from "../db/schema.js";
import { fail, intId, longText, validId, weekStart } from "./http.js";
import { avatarUrl, detailsFor, publicPlayer } from "./players.js";
import { publicAchievement, focusStats, challengeProgress } from "./achievements.js";
import type { Player } from "./auth.js";

const PAGE = 15;

// Shared achievements, newest first. Can be limited to one student, a community or a class.
export async function feed(url: URL, viewerId: string | null) {
  const before = Number(url.searchParams.get("before")) || 0;
  const player = url.searchParams.get("player");
  const community = url.searchParams.get("community");
  const grade = url.searchParams.get("grade");
  const section = url.searchParams.get("section");

  const where = [isNotNull(achievements.sharedAt), eq(achievements.hidden, false)];
  if (before > 0) where.push(lt(achievements.id, before));
  if (player) {
    if (!validId(player)) fail(400, "Invalid student.");
    where.push(eq(achievements.playerId, player));
  }
  if (community) {
    const cid = intId(community);
    where.push(inArray(achievements.playerId,
      db.select({ id: communityMembers.playerId }).from(communityMembers).where(eq(communityMembers.communityId, cid))));
  }
  if (grade) {
    const conds = [eq(studentDetails.grade, grade.slice(0, 12))];
    if (section) conds.push(eq(studentDetails.section, section.slice(0, 12)));
    where.push(inArray(achievements.playerId, db.select({ id: studentDetails.playerId }).from(studentDetails).where(and(...conds))));
  }

  const rows = await db.select({ a: achievements, name: players.name, avatarVersion: players.avatarVersion })
    .from(achievements).innerJoin(players, eq(players.id, achievements.playerId))
    .where(and(...where)).orderBy(desc(achievements.id)).limit(PAGE);

  const ids = rows.map(r => r.a.id);
  const [cheerCounts, commentCounts, mine, latest] = ids.length ? await Promise.all([
    db.select({ id: cheers.achievementId, n: sql<number>`count(*)::int` }).from(cheers)
      .where(inArray(cheers.achievementId, ids)).groupBy(cheers.achievementId),
    db.select({ id: comments.achievementId, n: sql<number>`count(*)::int` }).from(comments)
      .where(inArray(comments.achievementId, ids)).groupBy(comments.achievementId),
    viewerId ? db.select({ id: cheers.achievementId }).from(cheers)
      .where(and(inArray(cheers.achievementId, ids), eq(cheers.playerId, viewerId))) : Promise.resolve([]),
    // Recent comments on these cards; the two newest per card are shown as a preview.
    db.select({ id: comments.id, achievementId: comments.achievementId, body: comments.body, createdAt: comments.createdAt,
      playerId: comments.playerId, name: players.name })
      .from(comments).innerJoin(players, eq(players.id, comments.playerId))
      .where(inArray(comments.achievementId, ids)).orderBy(desc(comments.id)).limit(300),
  ]) : [[], [], [], []];

  const count = (list: { id: number; n: number }[], id: number) => list.find(x => x.id === id)?.n || 0;
  const items = rows.map(r => ({
    ...publicAchievement(r.a),
    student: { id: r.a.playerId, name: r.name, avatar: avatarUrl(r.a.playerId, r.avatarVersion) },
    cheers: count(cheerCounts, r.a.id),
    comments: count(commentCounts, r.a.id),
    cheered: mine.some(m => m.id === r.a.id),
    preview: latest.filter(c => c.achievementId === r.a.id).slice(0, 2).reverse()
      .map(c => ({ id: c.id, body: c.body, name: c.name, playerId: c.playerId, createdAt: c.createdAt })),
  }));
  return { items, next: rows.length === PAGE ? rows[rows.length - 1].a.id : null };
}

export async function myAchievements(p: Player) {
  const rows = await db.select().from(achievements).where(eq(achievements.playerId, p.id)).orderBy(desc(achievements.id));
  return rows.map(publicAchievement);
}

export async function share(p: Player, b: any) {
  const id = intId(b.id);
  const shared = b.shared !== false;
  const [row] = await db.update(achievements).set({ sharedAt: shared ? new Date() : null })
    .where(and(eq(achievements.id, id), eq(achievements.playerId, p.id))).returning();
  if (!row) fail(404, "Achievement not found.");
  return { ok: true, achievement: publicAchievement(row) };
}

async function visibleAchievement(id: number) {
  const [a] = await db.select({ id: achievements.id }).from(achievements)
    .where(and(eq(achievements.id, id), isNotNull(achievements.sharedAt), eq(achievements.hidden, false)));
  if (!a) fail(404, "That post isn't available any more.");
}

export async function cheer(p: Player, b: any) {
  const id = intId(b.id);
  await visibleAchievement(id);
  const on = b.on !== false;
  if (on) await db.insert(cheers).values({ achievementId: id, playerId: p.id }).onConflictDoNothing();
  else await db.delete(cheers).where(and(eq(cheers.achievementId, id), eq(cheers.playerId, p.id)));
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(cheers).where(eq(cheers.achievementId, id));
  return { ok: true, cheered: on, cheers: n };
}

export async function listComments(url: URL) {
  const id = intId(url.searchParams.get("id"));
  const rows = await db.select({ c: comments, name: players.name, avatarVersion: players.avatarVersion })
    .from(comments).innerJoin(players, eq(players.id, comments.playerId))
    .where(eq(comments.achievementId, id)).orderBy(comments.id).limit(200);
  return rows.map(r => ({
    id: r.c.id, body: r.c.body, createdAt: r.c.createdAt,
    student: { id: r.c.playerId, name: r.name, avatar: avatarUrl(r.c.playerId, r.avatarVersion) },
  }));
}

// Comments are short reactions: no links, so the feed stays about achievements.
const recentComments = new Map<string, number[]>();
export async function addComment(p: Player, b: any) {
  const id = intId(b.id);
  const body = longText(b.body, 280).replace(/\n{2,}/g, "\n");
  if (!body) fail(400, "Write something first.");
  if (/https?:\/\/|www\./i.test(body)) fail(400, "Links can't be posted in comments.");
  const now = Date.now();
  const mine = (recentComments.get(p.id) || []).filter(t => now - t < 60_000);
  if (mine.length >= 6) fail(429, "Slow down a little. Try again in a minute.");
  recentComments.set(p.id, [...mine, now]);
  await visibleAchievement(id);
  const [c] = await db.insert(comments).values({ achievementId: id, playerId: p.id, body }).returning();
  return { ok: true, comment: { id: c.id, body: c.body, createdAt: c.createdAt, student: { id: p.id, name: p.name, avatar: avatarUrl(p.id, p.avatarVersion) } } };
}

export async function deleteComment(p: Player | null, b: any, admin: boolean) {
  const id = intId(b.id);
  const where = admin ? eq(comments.id, id) : and(eq(comments.id, id), eq(comments.playerId, p!.id));
  const done = await db.delete(comments).where(where).returning({ id: comments.id });
  if (!done.length) fail(404, "Comment not found.");
  return { ok: true };
}

/* ===== Side panel on the feed: what's happening this week ===== */
export async function highlights() {
  const since = weekStart(new Date());
  const [focusTop, gameTop, now] = await Promise.all([
    db.select({ playerId: focusSessions.playerId, name: players.name, avatarVersion: players.avatarVersion,
      minutes: sql<number>`sum(${focusSessions.minutes})::int` })
      .from(focusSessions).innerJoin(players, eq(players.id, focusSessions.playerId))
      .where(and(eq(focusSessions.completed, true), sql`${focusSessions.endedAt} >= ${since.toISOString()}`))
      .groupBy(focusSessions.playerId, players.name, players.avatarVersion)
      .orderBy(desc(sql`sum(${focusSessions.minutes})`)).limit(5),
    db.select({ playerId: scores.playerId, name: players.name, avatarVersion: players.avatarVersion,
      score: sql<number>`max(${scores.score})::int`, game: sql<string>`(array_agg(${scores.game} order by ${scores.score} desc))[1]` })
      .from(scores).innerJoin(players, eq(players.id, scores.playerId))
      .where(sql`${scores.createdAt} >= ${since.toISOString()}`)
      .groupBy(scores.playerId, players.name, players.avatarVersion)
      .orderBy(desc(sql`max(${scores.score})`)).limit(5),
    focusingNow(),
  ]);
  const withAv = <T extends { playerId: string; avatarVersion: number | null }>(r: T) => ({ ...r, avatar: avatarUrl(r.playerId, r.avatarVersion) });
  return { focusTop: focusTop.map(withAv), gameTop: gameTop.map(withAv), focusingNow: now };
}

export async function focusingNow() {
  const [{ n }] = await db.select({ n: sql<number>`count(distinct ${focusSessions.playerId})::int` }).from(focusSessions)
    .where(and(sql`${focusSessions.endedAt} is null`,
      sql`${focusSessions.startedAt} + (${focusSessions.minutes} * interval '1 minute') > now()`));
  return n;
}

/* ===== Someone's profile (what other students can see) ===== */
export async function studentProfile(url: URL) {
  const id = url.searchParams.get("id");
  if (!validId(id)) fail(400, "Invalid student.");
  const [p] = await db.select().from(players).where(eq(players.id, id!));
  if (!p) fail(404, "Student not found.");
  const [d, focus, bests, [{ n: earned }]] = await Promise.all([
    detailsFor(p!.id),
    focusStats(p!.id),
    db.select({ game: scores.game, level: scores.level, best: sql<number>`max(${scores.score})::int` })
      .from(scores).where(eq(scores.playerId, p!.id)).groupBy(scores.game, scores.level),
    db.select({ n: sql<number>`count(*)::int` }).from(achievements).where(eq(achievements.playerId, p!.id)),
  ]);
  return {
    profile: { ...publicPlayer(p!, d), canLink: undefined },
    focus: { totalMinutes: focus.totalMinutes, sessions: focus.sessions, streak: focus.streak, longestStreak: focus.longestStreak },
    bests, earned,
  };
}

// Everything the Profile page needs for the signed-in student.
export async function me(p: Player) {
  const [d, list, focus, ch, bests] = await Promise.all([
    detailsFor(p.id), myAchievements(p), focusStats(p.id), challengeProgress(p.id),
    db.select({ game: scores.game, level: scores.level, best: sql<number>`max(${scores.score})::int`, rounds: sql<number>`count(*)::int` })
      .from(scores).where(eq(scores.playerId, p.id)).groupBy(scores.game, scores.level),
  ]);
  const { rows, ...focusSummary } = focus;
  return { profile: publicPlayer(p, d), achievements: list, focus: focusSummary, challenges: ch, bests };
}

/* ===== Teachers ===== */
export async function hideAchievement(b: any) {
  const id = intId(b.id);
  await db.update(achievements).set({ hidden: b.hidden !== false }).where(eq(achievements.id, id));
  return { ok: true };
}
