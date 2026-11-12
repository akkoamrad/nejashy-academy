import { getStore } from "@netlify/blobs";
import Anthropic from "@anthropic-ai/sdk";
import crypto from "node:crypto";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { players, games, scores } from "../../db/schema.js";

// Blob stores are created per request. Creating them at module load caches an
// access token that later expires ("Token expired" errors).
// Blobs now only hold files and pictures; player data and scores live in the database.
function stores() {
  return {
    files: getStore("academy-files"),
    metadata: getStore("academy-file-meta"),
    avatars: getStore({ name: "academy-avatars", consistency: "strong" }),
    legacyScores: getStore({ name: "academy-scores", consistency: "strong" }),
    legacyProfiles: getStore({ name: "academy-profiles", consistency: "strong" }),
    system: getStore({ name: "academy-system", consistency: "strong" }),
  };
}
type Stores = ReturnType<typeof stores>;

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });

/* ===== Admin session ===== */
const secret = () => process.env.SESSION_SECRET || "";
const sign = (value: string) => crypto.createHmac("sha256", secret()).update(value).digest("hex");
const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function makeSession() {
  const data = JSON.stringify({ admin: true, expires: Date.now() + 7 * 24 * 60 * 60 * 1000 });
  const encoded = Buffer.from(data).toString("base64url");
  return encoded + "." + sign(encoded);
}

function validSession(req: Request) {
  if (!secret()) return false;
  const match = (req.headers.get("cookie") || "").match(/academy_session=([^;]+)/);
  if (!match) return false;
  const [encoded, signature] = match[1].split(".");
  if (!encoded || !signature || !safeEqual(signature, sign(encoded))) return false;
  try {
    const data = JSON.parse(Buffer.from(encoded, "base64url").toString());
    return data.admin === true && data.expires > Date.now();
  } catch {
    return false;
  }
}

/* ===== Players ===== */
const cleanName = (n: unknown) => String(n ?? "").trim().replace(/\s+/g, " ").slice(0, 20);
const playerId = (name: string) =>
  crypto.createHash("sha256").update(cleanName(name).toLowerCase()).digest("hex").slice(0, 32);
const validId = (id: unknown): id is string => typeof id === "string" && /^[a-zA-Z0-9-]{1,64}$/.test(id);
const hashKey = (key: string) => crypto.createHash("sha256").update(key).digest("hex");

type Player = typeof players.$inferSelect;

const avatarUrl = (id: string, version: number | null) =>
  version ? `/.netlify/functions/api?action=avatar&id=${id}&v=${version}` : null;

const publicPlayer = (p: Player) => ({
  id: p.id,
  name: p.name,
  avatar: avatarUrl(p.id, p.avatarVersion),
  hasAvatar: !!p.avatarVersion,
  created_at: p.createdAt,
});

async function findPlayer(name: string) {
  const [p] = await db.select().from(players).where(eq(players.id, playerId(name)));
  return p;
}

/* ===== One-time import of players and scores saved before the database existed ===== */
let imported: Promise<void> | null = null;
function importLegacy(s: Stores) {
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

/* ===== Selfie check ===== */
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
    const text = msg.content.map(c => (c.type === "text" ? c.text : "")).join("");
    const found = text.match(/\{[\s\S]*\}/);
    if (!found) return fallback;
    const r = JSON.parse(found[0]);
    return { ok: r.ok === true, reason: String(r.reason || "") };
  } catch (err) {
    console.error("Selfie check failed", err);
    return fallback;
  }
}

/* ===== Math Arena ===== */
const LEVELS = ["easy", "medium", "hard"] as const;
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

async function leaderboard(level: string) {
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
    name: r.name, level: r.level, score: r.score, created_at: r.created_at,
    avatar: avatarUrl(r.playerId, r.avatarVersion),
  }));
}

/* ===== Files ===== */
// Files that a browser could run as a web page are always downloaded, never opened in the site.
const RISKY_TYPE = /html|xml|svg|javascript|ecmascript/i;

export default async function handler(req: Request) {
  try {
    const s = stores();
    const url = new URL(req.url);
    const action = url.searchParams.get("action");
    const GET = req.method === "GET";
    const POST = req.method === "POST";
    const body = async () => { try { return await req.json(); } catch { return {}; } };

    if (["profile", "selfie", "scores", "start", "players"].includes(action || "")) await importLegacy(s);

    // PUBLIC: list files
    if (GET && action === "files") {
      const { blobs } = await s.metadata.list();
      const list = (await Promise.all(blobs.map(b => s.metadata.get(b.key, { type: "json" }).catch(() => null))))
        .filter(Boolean) as any[];
      list.sort((a, b) => b.created_at - a.created_at);
      return json(list);
    }

    // PUBLIC: download a file
    if (GET && action === "download") {
      const id = url.searchParams.get("id");
      if (!validId(id)) return json({ error: "Invalid file ID" }, 400);
      const info = await s.metadata.get(id, { type: "json" });
      const blob = info && (await s.files.get(id, { type: "blob" }));
      if (!blob) return json({ error: "File not found" }, 404);
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

    // PUBLIC: look up a player by name
    if (GET && action === "profile") {
      const name = cleanName(url.searchParams.get("name"));
      if (!name) return json({ error: "Type a name." }, 400);
      const p = await findPlayer(name);
      return json(p ? { exists: true, profile: publicPlayer(p) } : { exists: false });
    }

    // PUBLIC: profile picture
    if (GET && action === "avatar") {
      const id = url.searchParams.get("id");
      if (!validId(id)) return json({ error: "Invalid ID" }, 400);
      const img = await s.avatars.get(id, { type: "arrayBuffer" });
      if (!img) return json({ error: "No picture" }, 404);
      return new Response(img, {
        headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=31536000, immutable" },
      });
    }

    // PUBLIC: save a verified selfie. Creates a new player, gives a reset player a new
    // picture, or lets the owner's device change their picture.
    if (POST && action === "selfie") {
      const b = await body();
      const name = cleanName(b.name);
      const m = String(b.image || "").match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/);
      if (!name) return json({ error: "Type your name first." }, 400);
      if (!m) return json({ error: "Please take or choose a photo." }, 400);
      const bytes = Buffer.from(m[1], "base64");
      if (bytes.length < 3000 || bytes.length > 2 * 1024 * 1024) {
        return json({ error: "That photo didn't come through. Please try another one." }, 400);
      }

      const existing = await findPlayer(name);
      const key = typeof b.key === "string" ? b.key : "";
      const isOwner = !!(existing?.ownerKeyHash && key && safeEqual(hashKey(key), existing.ownerKeyHash));
      if (existing?.avatarVersion && !isOwner) {
        return json({ error: "That name already has a picture.", profile: publicPlayer(existing) }, 409);
      }

      const check = await verifySelfie(m[1]);
      if (!check.ok) {
        return json({ error: check.reason || "That doesn't look like a real photo of your face. Try again.", rejected: true }, 422);
      }

      const id = playerId(name);
      const version = Date.now();
      // Keep the owner's existing key; otherwise issue a new one for this device.
      const newKey = isOwner ? key : crypto.randomBytes(24).toString("base64url");
      await s.avatars.set(id, bytes);
      const [saved] = await db.insert(players)
        .values({ id, name, avatarVersion: version, ownerKeyHash: hashKey(newKey) })
        .onConflictDoUpdate({ target: players.id, set: { avatarVersion: version, ownerKeyHash: hashKey(newKey) } })
        .returning();
      return json({ ok: true, profile: publicPlayer(saved), key: newKey, updated: !!existing });
    }

    // PUBLIC: leaderboard
    if (GET && action === "scores") {
      const level = url.searchParams.get("level") || "all";
      if (level !== "all" && !LEVELS.includes(level as any)) return json({ error: "Unknown level." }, 400);
      return json(await leaderboard(level));
    }

    // PUBLIC: start a Math Arena round
    if (POST && action === "start") {
      const b = await body();
      const level = String(b.level);
      if (!LEVELS.includes(level as any)) return json({ error: "Choose a level." }, 400);
      const p = await findPlayer(cleanName(b.name));
      if (!p?.avatarVersion) return json({ error: "Take your selfie first." }, 403);

      // Tidy up rounds that were started but never finished.
      await db.delete(games).where(lt(games.createdAt, new Date(Date.now() - 24 * 60 * 60 * 1000)));

      const id = crypto.randomUUID();
      const questions = Array.from({ length: QUESTIONS }, () => makeQuestion(level));
      await db.insert(games).values({ id, playerId: p.id, level, questions, questionStartedAt: Date.now() });
      return json({ gameId: id, total: QUESTIONS, timeMs: TIME_MS, index: 0, question: questions[0].q });
    }

    // PUBLIC: answer the current question. The server times and marks every answer.
    if (POST && action === "answer") {
      const b = await body();
      if (!validId(b.gameId)) return json({ error: "Unknown game." }, 400);
      const [g] = await db.select().from(games).where(eq(games.id, b.gameId));
      if (!g || g.finished) return json({ error: "This round has ended. Start a new one." }, 410);

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
      if (!done.length) return json({ error: "That question was already answered." }, 409);

      const reply: any = {
        correct, timedOut: !inTime || value === null, answer: q.ans, pts,
        score: update.score, streak, index: g.current,
      };
      if (!finished) {
        reply.next = { index: next, question: g.questions[next].q };
        return json(reply);
      }

      const [p] = await db.select().from(players).where(eq(players.id, g.playerId));
      await db.insert(scores).values({
        playerId: g.playerId, name: p?.name || "Player", level: g.level,
        score: update.score, correct: update.correct, bestStreak: update.bestStreak,
      });
      const [{ higher }] = await db.select({ higher: sql<number>`count(*)::int` }).from(scores)
        .where(and(eq(scores.level, g.level), sql`${scores.score} > ${update.score}`));
      await db.delete(games).where(eq(games.id, g.id));
      reply.result = {
        score: update.score, correct: update.correct, total: QUESTIONS,
        bestStreak: update.bestStreak, level: g.level, rank: higher + 1,
      };
      return json(reply);
    }

    // ADMIN: login / check / logout
    if (POST && action === "login") {
      const { password } = await body();
      const saved = process.env.ADMIN_PASSWORD || "";
      if (!saved || !secret()) return json({ error: "Admin login is not configured." }, 500);
      if (!safeEqual(String(password || ""), saved)) return json({ error: "Incorrect password." }, 401);
      return json({ ok: true }, 200, {
        "Set-Cookie": `academy_session=${makeSession()}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=604800`,
      });
    }

    if (GET && action === "check") return json({ loggedIn: validSession(req) });

    if (POST && action === "logout") {
      return json({ ok: true }, 200, {
        "Set-Cookie": "academy_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0",
      });
    }

    // Everything below requires admin login
    if (!validSession(req)) return json({ error: "Admin login required." }, 401);

    if (POST && action === "upload") {
      const form = await req.formData();
      const uploaded = form.getAll("files");
      const title = String(form.get("title") || "").trim().slice(0, 120);
      const note = String(form.get("note") || "").trim().slice(0, 1000);
      if (!uploaded.length) return json({ error: "Choose at least one file." }, 400);
      if (uploaded.some(f => !(f instanceof File) || f.size > 8 * 1024 * 1024)) {
        return json({ error: "Each file must be 8 MB or smaller." }, 400);
      }

      const result = [];
      for (const file of uploaded as File[]) {
        const id = crypto.randomUUID();
        const name = file.name.replace(/[\/\\]/g, "_");
        await s.files.set(id, file, { metadata: { contentType: file.type || "application/octet-stream" } });
        const info = {
          id, title: title || name, note, name,
          type: file.type || "application/octet-stream",
          size: file.size, created_at: Date.now(),
        };
        await s.metadata.setJSON(id, info);
        result.push(info);
      }
      return json({ ok: true, files: result });
    }

    if (POST && action === "delete") {
      const { id } = await body();
      if (!validId(id)) return json({ error: "Invalid file ID." }, 400);
      await s.files.delete(id);
      await s.metadata.delete(id);
      return json({ ok: true });
    }

    if (POST && action === "clear") {
      await db.delete(scores);
      return json({ ok: true });
    }

    if (GET && action === "players") {
      const all = await db.select().from(players).orderBy(desc(players.createdAt));
      return json(all.map(publicPlayer));
    }

    // Remove a player's picture. They keep their scores and take a new selfie next time.
    if (POST && action === "resetPlayer") {
      const { id } = await body();
      if (!validId(id)) return json({ error: "Invalid player ID." }, 400);
      await s.avatars.delete(id);
      await db.update(players).set({ avatarVersion: null, ownerKeyHash: null }).where(eq(players.id, id));
      return json({ ok: true });
    }

    return json({ error: "Unknown action." }, 404);
  } catch (error) {
    console.error(error);
    return json({ error: "Server error. Please try again." }, 500);
  }
}
