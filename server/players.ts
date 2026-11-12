// Student players: sign in by name, profile photo (selfie), details, device linking.
import Anthropic from "@anthropic-ai/sdk";
import crypto from "node:crypto";
import { and, desc, eq, gt, lt } from "drizzle-orm";
import { getStore } from "@netlify/blobs";
import { db } from "../db/index.js";
import { players, scores, studentDetails, deviceKeys, linkCodes } from "../db/schema.js";
import { fail, hashKey, text, validId } from "./http.js";
import { keyMatches, type Player } from "./auth.js";
import type { Stores } from "./stores.js";

export const cleanName = (n: unknown) => String(n ?? "").trim().replace(/\s+/g, " ").slice(0, 20);
export const playerId = (name: string) =>
  crypto.createHash("sha256").update(cleanName(name).toLowerCase()).digest("hex").slice(0, 32);

export const avatarUrl = (id: string, version: number | null) =>
  version ? `/.netlify/functions/api?action=avatar&id=${id}&v=${version}` : null;

export const publicPlayer = (p: Player, d?: { grade: string | null; section: string | null } | null) => ({
  id: p.id,
  name: p.name,
  avatar: avatarUrl(p.id, p.avatarVersion),
  hasAvatar: !!p.avatarVersion,
  canLink: !!p.ownerKeyHash, // has at least one device that can share a link code
  grade: d?.grade ?? null,
  section: d?.section ?? null,
  created_at: p.createdAt,
});

export async function findPlayer(name: string) {
  const [p] = await db.select().from(players).where(eq(players.id, playerId(name)));
  return p;
}

export async function detailsFor(id: string) {
  const [d] = await db.select().from(studentDetails).where(eq(studentDetails.playerId, id));
  return d || null;
}

/* ===== One-time import of players and scores saved before the database existed ===== */
let imported: Promise<void> | null = null;
export function importLegacy(s: Stores) {
  imported ??= (async () => {
    if (await s.system.get("legacy-import-v1")) return;
    const readAll = async (store: ReturnType<typeof getStore>) => {
      const { blobs } = await store.list();
      const items = await Promise.all(blobs.map(b => store.get(b.key, { type: "json" }).catch(() => null)));
      return items.filter(Boolean) as any[];
    };
    const [oldPlayers, oldScores] = await Promise.all([readAll(s.legacyProfiles), readAll(s.legacyScores)]);
    for (const p of oldPlayers) {
      if (!validId(p.id) || !p.name) continue;
      await db.insert(players).values({
        id: p.id, name: cleanName(p.name), avatarVersion: Number(p.created_at) || Date.now(),
        createdAt: new Date(Number(p.created_at) || Date.now()),
      }).onConflictDoNothing();
    }
    for (const sc of oldScores) {
      const id = playerId(sc.name);
      if (!oldPlayers.some(p => p.id === id) || !["easy", "medium", "hard"].includes(sc.level)) continue;
      await db.insert(scores).values({
        playerId: id, name: cleanName(sc.name), level: sc.level, score: Math.floor(Number(sc.score) || 0),
        createdAt: new Date(Number(sc.created_at) || Date.now()),
      });
    }
    await s.system.set("legacy-import-v1", String(Date.now()));
  })().catch(err => { imported = null; console.error("Legacy import failed", err); });
  return imported;
}

/* ===== Selfie check (AI) ===== */
async function verifySelfie(base64: string): Promise<{ ok: boolean; reason: string }> {
  const fallback = { ok: false, reason: "We couldn't check that photo. Please try again." };
  try {
    const anthropic = new Anthropic();
    const msg = await anthropic.messages.create({
      model: "claude-haiku-5-5",
      max_tokens: 200,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: base64 } },
          {
            type: "text",
            text:
              "This photo will be a student's profile picture on a school website. It was either taken just now with the device camera " +
              "or chosen from the student's own photos. Decide if it is a REAL PHOTO OF ONE PERSON'S FACE: a single real human, face clearly " +
              "visible and reasonably lit. Normal selfies, school photos and portrait photos are fine. " +
              "Reject it if it shows: no face, more than one person, a face too dark/blurry/covered to see, a photo of a screen or of a printed photo, " +
              "a drawing, cartoon, AI art, toy, mask, animal, poster, celebrity image, or object, or anything inappropriate for a school. " +
              'Reply with ONLY JSON: {"ok": true|false, "reason": "short friendly sentence telling the student what to fix (empty if ok)"}',
          },
        ],
      }],
    });
    const out = msg.content.map(c => (c.type === "text" ? c.text : "")).join("");
    const found = out.match(/\{[\s\S]*\}/);
    if (!found) return fallback;
    const r = JSON.parse(found[0]);
    return { ok: r.ok === true, reason: String(r.reason || "") };
  } catch (err) {
    console.error("Selfie check failed", err);
    return fallback;
  }
}

/* ===== Actions ===== */

// Look up a student by name (the sign-in screen).
export async function profile(url: URL) {
  const name = cleanName(url.searchParams.get("name"));
  if (!name) fail(400, "Type a name.");
  const p = await findPlayer(name);
  return p ? { exists: true, profile: publicPlayer(p, await detailsFor(p.id)) } : { exists: false };
}

export async function avatar(url: URL, s: Stores) {
  const id = url.searchParams.get("id");
  if (!validId(id)) fail(400, "Invalid ID");
  const img = await s.avatars.get(id!, { type: "arrayBuffer" });
  if (!img) fail(404, "No picture");
  return new Response(img, {
    headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=31536000, immutable" },
  });
}

// Save a verified selfie. Creates a new player, gives a reset player a new
// picture, or lets the owner's device change their picture.
export async function selfie(b: any, s: Stores) {
  const name = cleanName(b.name);
  const m = String(b.image || "").match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/);
  if (!name) fail(400, "Type your name first.");
  if (!m) fail(400, "Please take or choose a photo.");
  const bytes = Buffer.from(m![1], "base64");
  if (bytes.length < 3000 || bytes.length > 2 * 1024 * 1024) fail(400, "That photo didn't come through. Please try another one.");

  const existing = await findPlayer(name);
  const key = typeof b.key === "string" ? b.key : "";
  const isOwner = !!(existing && (await keyMatches(existing, key)));
  if (existing?.avatarVersion && !isOwner) {
    fail(409, "That name already has a picture.", { profile: publicPlayer(existing, await detailsFor(existing.id)) });
  }

  const check = await verifySelfie(m![1]);
  if (!check.ok) fail(422, check.reason || "That doesn't look like a real photo of your face. Try again.", { rejected: true });

  const id = playerId(name);
  const version = Date.now();
  await s.avatars.set(id, bytes);
  let newKey = key;
  if (isOwner) {
    await db.update(players).set({ avatarVersion: version }).where(eq(players.id, id));
  } else {
    newKey = crypto.randomBytes(24).toString("base64url");
    await db.insert(players)
      .values({ id, name, avatarVersion: version, ownerKeyHash: hashKey(newKey) })
      .onConflictDoUpdate({ target: players.id, set: { avatarVersion: version, ownerKeyHash: hashKey(newKey) } });
  }
  const [saved] = await db.select().from(players).where(eq(players.id, id));
  return { ok: true, profile: publicPlayer(saved, await detailsFor(id)), key: newKey, updated: !!existing };
}

// Update grade / class from Profile > Account settings.
export async function saveDetails(p: Player, b: any) {
  const grade = text(b.grade, 12) || null;
  const section = text(b.section, 12) || null;
  await db.insert(studentDetails).values({ playerId: p.id, grade, section })
    .onConflictDoUpdate({ target: studentDetails.playerId, set: { grade, section, updatedAt: new Date() } });
  return { ok: true, profile: publicPlayer(p, { grade, section }) };
}

// A linked device asks for a 6-digit code; a new device types it in to get its own key.
export async function createLinkCode(p: Player) {
  await db.delete(linkCodes).where(lt(linkCodes.expiresAt, new Date()));
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  await db.insert(linkCodes).values({ codeHash: hashKey(p.id + ":" + code), playerId: p.id, expiresAt }).onConflictDoNothing();
  return { code, expiresAt };
}

const linkTries = new Map<string, { n: number; t: number }>();
export async function redeemLinkCode(b: any) {
  const name = cleanName(b.name);
  const code = String(b.code || "").replace(/\D/g, "");
  const p = name ? await findPlayer(name) : null;
  if (!p) fail(404, "No student with that name.");
  // Slow down guessing: 5 wrong tries per student per 10 minutes (per server instance).
  const tries = linkTries.get(p!.id);
  if (tries && tries.n >= 5 && Date.now() - tries.t < 10 * 60 * 1000) fail(429, "Too many tries. Wait a few minutes and get a new code.");
  const [row] = await db.select().from(linkCodes)
    .where(and(eq(linkCodes.codeHash, hashKey(p!.id + ":" + code)), gt(linkCodes.expiresAt, new Date())));
  if (!row) {
    linkTries.set(p!.id, { n: (tries && Date.now() - tries.t < 6e5 ? tries.n : 0) + 1, t: Date.now() });
    fail(400, "That code is wrong or has expired.");
  }
  await db.delete(linkCodes).where(eq(linkCodes.codeHash, row.codeHash));
  linkTries.delete(p!.id);
  const key = crypto.randomBytes(24).toString("base64url");
  await db.insert(deviceKeys).values({ keyHash: hashKey(key), playerId: p!.id });
  return { ok: true, key, profile: publicPlayer(p!, await detailsFor(p!.id)) };
}

/* ===== Teacher actions ===== */
export async function listPlayers() {
  const all = await db.select().from(players).leftJoin(studentDetails, eq(studentDetails.playerId, players.id))
    .orderBy(desc(players.createdAt));
  return all.map(r => publicPlayer(r.players, r.student_details));
}

// Remove a student's picture and unlink all their devices. They keep their scores
// and achievements, and take a new selfie next time (which links that device).
export async function resetPlayer(b: any, s: Stores) {
  if (!validId(b.id)) fail(400, "Invalid player ID.");
  await s.avatars.delete(b.id);
  await db.update(players).set({ avatarVersion: null, ownerKeyHash: null }).where(eq(players.id, b.id));
  await db.delete(deviceKeys).where(eq(deviceKeys.playerId, b.id));
  return { ok: true };
}

export async function adminSetDetails(b: any) {
  if (!validId(b.id)) fail(400, "Invalid player ID.");
  const [p] = await db.select().from(players).where(eq(players.id, b.id));
  if (!p) fail(404, "Student not found.");
  return saveDetails(p!, b);
}

