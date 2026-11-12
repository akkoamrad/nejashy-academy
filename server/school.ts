// Announcements, communities (school clubs and groups) and the shared files library.
import crypto from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { announcements, communities, communityMembers, focusSessions, players, studentDetails } from "../db/schema.js";
import { fail, intId, longText, optional, text, validId, weekStart } from "./http.js";
import { avatarUrl, detailsFor } from "./players.js";
import type { Player } from "./auth.js";
import type { Stores } from "./stores.js";

/* ===== Announcements ===== */
export async function listAnnouncements(p: Player | null) {
  const d = p ? await detailsFor(p.id) : null;
  const grade = d?.grade ?? null, section = d?.section ?? null;
  return db.select().from(announcements)
    .where(and(
      grade ? or(isNull(announcements.grade), eq(announcements.grade, grade)) : isNull(announcements.grade),
      section ? or(isNull(announcements.section), eq(announcements.section, section)) : isNull(announcements.section),
    ))
    .orderBy(desc(announcements.pinned), desc(announcements.createdAt)).limit(100);
}

export const adminAnnouncements = () => db.select().from(announcements).orderBy(desc(announcements.createdAt));

export async function addAnnouncement(b: any) {
  const title = text(b.title, 120);
  if (!title) fail(400, "Type a title.");
  const [row] = await db.insert(announcements).values({
    title, body: longText(b.body, 4000), pinned: !!b.pinned, grade: optional(b.grade, 12), section: optional(b.section, 12),
  }).returning();
  return { ok: true, announcement: row };
}

export async function pinAnnouncement(b: any) {
  await db.update(announcements).set({ pinned: !!b.pinned }).where(eq(announcements.id, intId(b.id)));
  return { ok: true };
}

export async function deleteAnnouncement(b: any) {
  await db.delete(announcements).where(eq(announcements.id, intId(b.id)));
  return { ok: true };
}

/* ===== Communities ===== */
export async function listCommunities(p: Player | null) {
  const rows = await db.select({
    c: communities,
    members: sql<number>`(select count(*)::int from ${communityMembers} m where m.community_id = ${communities.id})`,
  }).from(communities).orderBy(asc(communities.name));
  const mine = p ? await db.select({ id: communityMembers.communityId }).from(communityMembers).where(eq(communityMembers.playerId, p.id)) : [];
  const d = p ? await detailsFor(p.id) : null;
  let classmates = 0;
  if (d?.grade) {
    const conds = [eq(studentDetails.grade, d.grade)];
    if (d.section) conds.push(eq(studentDetails.section, d.section));
    [{ n: classmates }] = await db.select({ n: sql<number>`count(*)::int` }).from(studentDetails).where(and(...conds));
  }
  return {
    myClass: d?.grade ? { grade: d.grade, section: d.section, members: classmates } : null,
    communities: rows.map(r => ({ ...r.c, members: r.members, joined: mine.some(m => m.id === r.c.id) })),
  };
}

// Members of one community (or of the student's class) with their focus minutes this week.
export async function communityDetail(url: URL, p: Player | null) {
  const which = url.searchParams.get("id");
  let memberIds: string[];
  let info: any;
  if (which === "class") {
    const d = p ? await detailsFor(p.id) : null;
    if (!d?.grade) fail(400, "Add your grade in Profile to see your class.");
    const conds = [eq(studentDetails.grade, d!.grade!)];
    if (d!.section) conds.push(eq(studentDetails.section, d!.section));
    memberIds = (await db.select({ id: studentDetails.playerId }).from(studentDetails).where(and(...conds))).map(r => r.id);
    info = { id: "class", name: `Grade ${d!.grade}${d!.section ? " " + d!.section : ""}`, icon: "🏫",
      description: "Everyone in your class. Join automatically when you set your grade and section.", joined: true,
      grade: d!.grade, section: d!.section };
  } else {
    const id = intId(which);
    const [c] = await db.select().from(communities).where(eq(communities.id, id));
    if (!c) fail(404, "Community not found.");
    memberIds = (await db.select({ id: communityMembers.playerId }).from(communityMembers).where(eq(communityMembers.communityId, id))).map(r => r.id);
    info = { ...c, joined: !!p && memberIds.includes(p.id) };
  }
  if (!memberIds.length) return { community: info, members: [] };
  const since = weekStart(new Date());
  const rows = await db.select({
    id: players.id, name: players.name, avatarVersion: players.avatarVersion,
    week: sql<number>`coalesce((select sum(f.minutes)::int from ${focusSessions} f where f.player_id = ${players.id} and f.completed and f.ended_at >= ${since.toISOString()}), 0)`,
  }).from(players).where(inArray(players.id, memberIds));
  rows.sort((a, b) => b.week - a.week || a.name.localeCompare(b.name));
  return {
    community: info,
    weekMinutes: rows.reduce((t, r) => t + r.week, 0),
    members: rows.map(r => ({ id: r.id, name: r.name, avatar: avatarUrl(r.id, r.avatarVersion), weekMinutes: r.week })),
  };
}

export async function joinCommunity(p: Player, b: any) {
  const id = intId(b.id);
  const [c] = await db.select({ id: communities.id }).from(communities).where(eq(communities.id, id));
  if (!c) fail(404, "Community not found.");
  if (b.join === false) await db.delete(communityMembers).where(and(eq(communityMembers.communityId, id), eq(communityMembers.playerId, p.id)));
  else await db.insert(communityMembers).values({ communityId: id, playerId: p.id }).onConflictDoNothing();
  return { ok: true, joined: b.join !== false };
}

export async function addCommunity(b: any) {
  const name = text(b.name, 60);
  if (!name) fail(400, "Type a name.");
  const icon = [...text(b.icon, 8)].slice(0, 2).join("") || "👥";
  const [row] = await db.insert(communities).values({ name, description: longText(b.description, 500), icon }).returning();
  return { ok: true, community: row };
}

export async function deleteCommunity(b: any) {
  await db.delete(communities).where(eq(communities.id, intId(b.id)));
  return { ok: true };
}

/* ===== Shared files (library) ===== */
// Files that a browser could run as a web page are always downloaded, never opened in the site.
const RISKY_TYPE = /html|xml|svg|javascript|ecmascript/i;

export async function listFiles(s: Stores) {
  const { blobs } = await s.metadata.list();
  const list = (await Promise.all(blobs.map(b => s.metadata.get(b.key, { type: "json" }).catch(() => null)))).filter(Boolean) as any[];
  list.sort((a, b) => b.created_at - a.created_at);
  return list;
}

export async function download(url: URL, s: Stores) {
  const id = url.searchParams.get("id");
  if (!validId(id)) fail(400, "Invalid file ID");
  const info = await s.metadata.get(id!, { type: "json" });
  const blob = info && (await s.files.get(id!, { type: "blob" }));
  if (!blob) fail(404, "File not found");
  const type = info.type || "application/octet-stream";
  const disposition = RISKY_TYPE.test(type) ? "attachment" : "inline";
  return new Response(blob, {
    headers: {
      "Content-Type": type,
      "Content-Disposition": `${disposition}; filename*=UTF-8''${encodeURIComponent(info.name)}`,
      "Content-Security-Policy": "sandbox",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "public, max-age=3600",
    },
  });
}

export async function upload(req: Request, s: Stores) {
  const form = await req.formData();
  const uploaded = form.getAll("files");
  const title = String(form.get("title") || "").trim().slice(0, 120);
  const note = String(form.get("note") || "").trim().slice(0, 1000);
  if (!uploaded.length) fail(400, "Choose at least one file.");
  if (uploaded.some(f => !(f instanceof File) || f.size > 8 * 1024 * 1024)) fail(400, "Each file must be 8 MB or smaller.");
  const result = [];
  for (const file of uploaded as File[]) {
    const id = crypto.randomUUID();
    const name = file.name.replace(/[\/\\]/g, "_");
    await s.files.set(id, file, { metadata: { contentType: file.type || "application/octet-stream" } });
    const info = { id, title: title || name, note, name, type: file.type || "application/octet-stream", size: file.size, created_at: Date.now() };
    await s.metadata.setJSON(id, info);
    result.push(info);
  }
  return { ok: true, files: result };
}

export async function deleteFile(b: any, s: Stores) {
  if (!validId(b.id)) fail(400, "Invalid file ID.");
  await s.files.delete(b.id);
  await s.metadata.delete(b.id);
  return { ok: true };
}
