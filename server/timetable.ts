// Timetable: weekly classes, tests, assignment deadlines, school dates and the
// student's own calendar entries, filtered to the student's grade and section.
import { and, asc, eq, gte, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { assignmentDone, calendarItems, classes, personalEvents } from "../db/schema.js";
import { dayKey, fail, intId, isDate, isTime, longText, optional, text } from "./http.js";
import { detailsFor } from "./players.js";
import type { Player } from "./auth.js";

export const KINDS = ["test", "assignment", "event", "holiday"] as const;

// "For everyone" rows have no grade/section; otherwise they must match the student.
const forStudent = (col: { grade: any; section: any }, grade: string | null, section: string | null) => and(
  grade ? or(isNull(col.grade), eq(col.grade, grade)) : isNull(col.grade),
  section ? or(isNull(col.section), eq(col.section, section)) : isNull(col.section),
);

const shift = (key: string, days: number) => new Date(Date.parse(key) + days * 864e5).toISOString().slice(0, 10);

export async function timetable(p: Player) {
  const d = await detailsFor(p.id);
  const grade = d?.grade ?? null, section = d?.section ?? null;
  const today = dayKey(new Date());
  const [week, items, mine, done] = await Promise.all([
    db.select().from(classes).where(forStudent(classes, grade, section)).orderBy(asc(classes.day), asc(classes.startTime)),
    db.select().from(calendarItems)
      .where(and(forStudent(calendarItems, grade, section),
        or(gte(calendarItems.date, shift(today, -120)), gte(calendarItems.endDate, shift(today, -120))),
        lte(calendarItems.date, shift(today, 400))))
      .orderBy(asc(calendarItems.date), asc(calendarItems.time)),
    db.select().from(personalEvents).where(eq(personalEvents.playerId, p.id)).orderBy(asc(personalEvents.date), asc(personalEvents.time)),
    db.select({ id: assignmentDone.itemId }).from(assignmentDone).where(eq(assignmentDone.playerId, p.id)),
  ]);
  const doneIds = new Set(done.map(x => x.id));
  return {
    today, grade, section,
    classes: week,
    items: items.map(i => ({ ...i, done: i.kind === "assignment" ? doneIds.has(i.id) : undefined })),
    personal: mine,
  };
}

export async function addPersonal(p: Player, b: any) {
  const title = text(b.title, 80);
  if (!title) fail(400, "Give it a title.");
  if (!isDate(b.date)) fail(400, "Choose a date.");
  if (b.time && !isTime(b.time)) fail(400, "Time looks wrong.");
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(personalEvents).where(eq(personalEvents.playerId, p.id));
  if (n >= 500) fail(400, "Your calendar is full. Remove some old entries first.");
  const [row] = await db.insert(personalEvents).values({
    playerId: p.id, title, date: b.date, time: b.time || "", note: longText(b.note, 300),
  }).returning();
  return { ok: true, event: row };
}

export async function deletePersonal(p: Player, b: any) {
  const id = intId(b.id);
  await db.delete(personalEvents).where(and(eq(personalEvents.id, id), eq(personalEvents.playerId, p.id)));
  return { ok: true };
}

export async function toggleAssignment(p: Player, b: any) {
  const id = intId(b.id);
  const [item] = await db.select({ kind: calendarItems.kind }).from(calendarItems).where(eq(calendarItems.id, id));
  if (!item || item.kind !== "assignment") fail(404, "Assignment not found.");
  if (b.done === false) await db.delete(assignmentDone).where(and(eq(assignmentDone.playerId, p.id), eq(assignmentDone.itemId, id)));
  else await db.insert(assignmentDone).values({ playerId: p.id, itemId: id }).onConflictDoNothing();
  return { ok: true, done: b.done !== false };
}

/* ===== Teachers ===== */
export async function adminListTimetable() {
  const [c, i] = await Promise.all([
    db.select().from(classes).orderBy(asc(classes.grade), asc(classes.section), asc(classes.day), asc(classes.startTime)),
    db.select().from(calendarItems).orderBy(asc(calendarItems.date)),
  ]);
  return { classes: c, items: i };
}

export async function addClass(b: any) {
  const day = Number(b.day);
  if (!Number.isInteger(day) || day < 1 || day > 7) fail(400, "Choose a day.");
  if (!isTime(b.startTime) || !isTime(b.endTime) || b.endTime <= b.startTime) fail(400, "Check the start and end times.");
  const subject = text(b.subject, 60);
  if (!subject) fail(400, "Type the subject.");
  const [row] = await db.insert(classes).values({
    day, startTime: b.startTime, endTime: b.endTime, subject,
    teacher: text(b.teacher, 60), room: text(b.room, 30),
    grade: optional(b.grade, 12), section: optional(b.section, 12),
  }).returning();
  return { ok: true, class: row };
}

export async function deleteClass(b: any) {
  await db.delete(classes).where(eq(classes.id, intId(b.id)));
  return { ok: true };
}

export async function addItem(b: any) {
  if (!KINDS.includes(b.kind)) fail(400, "Choose a type.");
  const title = text(b.title, 100);
  if (!title) fail(400, "Type a title.");
  if (!isDate(b.date)) fail(400, "Choose a date.");
  if (b.endDate && (!isDate(b.endDate) || b.endDate < b.date)) fail(400, "The end date must be after the start date.");
  if (b.time && !isTime(b.time)) fail(400, "Time looks wrong.");
  const [row] = await db.insert(calendarItems).values({
    kind: b.kind, title, subject: text(b.subject, 60), details: longText(b.details, 1000),
    date: b.date, endDate: b.endDate || null, time: b.time || "",
    grade: optional(b.grade, 12), section: optional(b.section, 12),
  }).returning();
  return { ok: true, item: row };
}

export async function deleteItem(b: any) {
  await db.delete(calendarItems).where(eq(calendarItems.id, intId(b.id)));
  return { ok: true };
}
