// Focus Hub. The server notes when a session starts; it only counts as completed
// if the full time has really passed, so focus minutes can't be faked.
import crypto from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { focusSessions } from "../db/schema.js";
import { dayKey, fail, text, validId } from "./http.js";
import { afterFocusSession, challengeProgress, focusStats } from "./achievements.js";
import { focusingNow } from "./feed.js";
import type { Player } from "./auth.js";

export const LENGTHS = [10, 15, 20, 25, 30, 45, 50, 60, 90] as const;
const EARLY_MS = 5000; // allowance for clocks and network delay

const publicSession = (s: typeof focusSessions.$inferSelect) => ({
  id: s.id, minutes: s.minutes, label: s.label, startedAt: s.startedAt,
  endsAt: new Date(s.startedAt.getTime() + s.minutes * 60_000),
});

async function openSession(playerId: string) {
  const [s] = await db.select().from(focusSessions)
    .where(and(eq(focusSessions.playerId, playerId), isNull(focusSessions.endedAt)))
    .orderBy(desc(focusSessions.startedAt)).limit(1);
  return s;
}

export async function startFocus(p: Player, b: any) {
  const minutes = Number(b.minutes);
  if (!LENGTHS.includes(minutes as any)) fail(400, "Choose a session length.");
  const label = text(b.label, 40);
  // Only one session at a time: starting a new one abandons any unfinished one.
  await db.update(focusSessions).set({ endedAt: new Date(), completed: false })
    .where(and(eq(focusSessions.playerId, p.id), isNull(focusSessions.endedAt)));
  const [s] = await db.insert(focusSessions).values({ id: crypto.randomUUID(), playerId: p.id, minutes, label }).returning();
  return { session: publicSession(s), serverNow: Date.now() };
}

export async function completeFocus(p: Player, b: any) {
  if (!validId(b.id)) fail(400, "Unknown session.");
  const [s] = await db.select().from(focusSessions).where(and(eq(focusSessions.id, b.id), eq(focusSessions.playerId, p.id)));
  if (!s) fail(404, "Session not found.");
  if (s!.endedAt) fail(410, s!.completed ? "This session was already completed." : "This session was stopped.");
  const due = s!.startedAt.getTime() + s!.minutes * 60_000;
  if (Date.now() + EARLY_MS < due) fail(400, "This session isn't finished yet.", { endsAt: new Date(due) });
  const done = await db.update(focusSessions).set({ endedAt: new Date(), completed: true })
    .where(and(eq(focusSessions.id, s!.id), isNull(focusSessions.endedAt))).returning({ id: focusSessions.id });
  if (!done.length) fail(410, "This session was already completed.");
  const earned = await afterFocusSession(p.id, { id: s!.id, minutes: s!.minutes, label: s!.label }).catch(err => {
    console.error("Achievement check failed", err);
    return [];
  });
  return { ok: true, minutes: s!.minutes, achievements: earned, ...(await focusState(p)) };
}

export async function stopFocus(p: Player, b: any) {
  if (!validId(b.id)) fail(400, "Unknown session.");
  await db.update(focusSessions).set({ endedAt: new Date(), completed: false })
    .where(and(eq(focusSessions.id, b.id), eq(focusSessions.playerId, p.id), isNull(focusSessions.endedAt)));
  return { ok: true };
}

// Everything the Focus Hub page shows.
export async function focusState(p: Player) {
  const [active, stats, ch, now, labels] = await Promise.all([
    openSession(p.id), focusStats(p.id), challengeProgress(p.id), focusingNow(),
    db.select({ label: focusSessions.label, minutes: sql<number>`sum(${focusSessions.minutes})::int` })
      .from(focusSessions).where(and(eq(focusSessions.playerId, p.id), eq(focusSessions.completed, true)))
      .groupBy(focusSessions.label).orderBy(desc(sql`sum(${focusSessions.minutes})`)).limit(6),
  ]);
  // Minutes per day for the last 12 weeks (for the heatmap and the week chart).
  const days: Record<string, number> = {};
  for (const r of stats.rows) {
    const k = dayKey(r.endedAt!);
    days[k] = (days[k] || 0) + r.minutes;
  }
  // The garden: one plant per completed session, newest 60. Bigger sessions grow bigger plants.
  const garden = stats.rows.slice(0, 60).map(r => r.minutes);
  const { rows, ...summary } = stats;
  // If the open session ran out more than a day ago, treat it as abandoned.
  const live = active && active.startedAt.getTime() + active.minutes * 60_000 > Date.now() - 864e5 ? publicSession(active) : null;
  return {
    active: live, serverNow: Date.now(), stats: summary, days, garden,
    subjects: labels.filter(l => l.label).map(l => ({ label: l.label, minutes: l.minutes })),
    challenges: ch, focusingNow: now, lengths: LENGTHS,
  };
}
