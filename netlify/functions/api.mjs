import { getStore } from "@netlify/blobs";
import Anthropic from "@anthropic-ai/sdk";
import crypto from "node:crypto";

// Stores are created per request (see handler). Creating them at module load
// caches a Blobs access token that later expires ("Token expired" errors).
function stores() {
  return {
    files: getStore("academy-files"),
    metadata: getStore("academy-file-meta"),
    scores: getStore({ name: "academy-scores", consistency: "strong" }),
    profiles: getStore({ name: "academy-profiles", consistency: "strong" }),
    avatars: getStore({ name: "academy-avatars", consistency: "strong" })
  };
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });

/* ===== Admin session ===== */
const secret = () => process.env.SESSION_SECRET || "";
const sign = value => crypto.createHmac("sha256", secret()).update(value).digest("hex");

function makeSession() {
  const data = JSON.stringify({ admin: true, expires: Date.now() + 7 * 24 * 60 * 60 * 1000 });
  const encoded = Buffer.from(data).toString("base64url");
  return encoded + "." + sign(encoded);
}

function validSession(req) {
  if (!secret()) return false;
  const match = (req.headers.get("cookie") || "").match(/academy_session=([^;]+)/);
  if (!match) return false;
  const [encoded, signature] = match[1].split(".");
  if (!encoded || !signature) return false;
  const expected = sign(encoded);
  if (
    signature.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  ) return false;
  try {
    const data = JSON.parse(Buffer.from(encoded, "base64url").toString());
    return data.admin === true && data.expires > Date.now();
  } catch {
    return false;
  }
}

/* ===== Player profiles ===== */
const cleanName = n => String(n || "").trim().replace(/\s+/g, " ").slice(0, 20);
const profileId = name =>
  crypto.createHash("sha256").update(cleanName(name).toLowerCase()).digest("hex").slice(0, 32);
const validId = id => typeof id === "string" && /^[a-zA-Z0-9-]{1,64}$/.test(id);

async function readAll(store) {
  const { blobs } = await store.list();
  const items = await Promise.all(
    blobs.map(b => store.get(b.key, { type: "json" }).catch(() => null))
  );
  return items.filter(Boolean);
}

const publicProfile = p => ({
  id: p.id,
  name: p.name,
  avatar: `/.netlify/functions/api?action=avatar&id=${p.id}&v=${p.created_at}`,
  created_at: p.created_at
});

// Ask a vision model whether the photo is a genuine, live selfie of a real person.
async function verifySelfie(base64) {
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
            "This image was just taken with a device's front camera to be a student's profile picture on a school website. " +
            "Decide if it is a REAL SELFIE: a live photo of one real human person's face, clearly visible and reasonably lit. " +
            "Reject it if it shows: no face, a face too dark/blurry/covered to see, a photo or screen being held up to the camera, " +
            "a drawing, cartoon, toy, mask, animal, poster, or object, or anything inappropriate for a school. " +
            'Reply with ONLY JSON: {"ok": true|false, "reason": "short friendly sentence telling the student what to fix (empty if ok)"}'
        }
      ]
    }]
  });
  const text = msg.content.filter(c => c.type === "text").map(c => c.text).join("");
  const found = text.match(/\{[\s\S]*\}/);
  if (!found) return { ok: false, reason: "We couldn't check that photo. Please try again." };
  try {
    const r = JSON.parse(found[0]);
    return { ok: r.ok === true, reason: String(r.reason || "") };
  } catch {
    return { ok: false, reason: "We couldn't check that photo. Please try again." };
  }
}

export default async function handler(req) {
  try {
    const { files, metadata, scores, profiles, avatars } = stores();
    const url = new URL(req.url);
    const action = url.searchParams.get("action");
    const GET = req.method === "GET";
    const POST = req.method === "POST";

    // PUBLIC: list files
    if (GET && action === "files") {
      const result = await readAll(metadata);
      result.sort((a, b) => b.created_at - a.created_at);
      return json(result);
    }

    // PUBLIC: download a file
    if (GET && action === "download") {
      const id = url.searchParams.get("id");
      if (!validId(id)) return json({ error: "Invalid file ID" }, 400);
      const info = await metadata.get(id, { type: "json" });
      const blob = info && await files.get(id, { type: "blob" });
      if (!blob) return json({ error: "File not found" }, 404);
      return new Response(blob, {
        headers: {
          "Content-Type": info.type || "application/octet-stream",
          "Content-Disposition": `inline; filename="${encodeURIComponent(info.name)}"`,
          "Cache-Control": "public, max-age=3600"
        }
      });
    }

    // PUBLIC: look up a player by name
    if (GET && action === "profile") {
      const name = cleanName(url.searchParams.get("name"));
      if (!name) return json({ error: "Type a name." }, 400);
      const p = await profiles.get(profileId(name), { type: "json" });
      return json(p ? { exists: true, profile: publicProfile(p) } : { exists: false });
    }

    // PUBLIC: profile picture
    if (GET && action === "avatar") {
      const id = url.searchParams.get("id");
      if (!validId(id)) return json({ error: "Invalid ID" }, 400);
      const img = await avatars.get(id, { type: "arrayBuffer" });
      if (!img) return json({ error: "No picture" }, 404);
      return new Response(img, {
        headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=31536000, immutable" }
      });
    }

    // PUBLIC: create a player with a verified selfie
    if (POST && action === "selfie") {
      const body = await req.json();
      const name = cleanName(body.name);
      const m = String(body.image || "").match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/);
      if (!name) return json({ error: "Type your name first." }, 400);
      if (!m) return json({ error: "Please take a photo with your camera." }, 400);
      const bytes = Buffer.from(m[1], "base64");
      if (bytes.length < 3000 || bytes.length > 2 * 1024 * 1024) {
        return json({ error: "That photo didn't come through. Please retake it." }, 400);
      }

      const id = profileId(name);
      const existing = await profiles.get(id, { type: "json" });
      if (existing) {
        return json({ error: "That name already has a picture.", profile: publicProfile(existing) }, 409);
      }

      const check = await verifySelfie(m[1]);
      if (!check.ok) {
        return json({ error: check.reason || "That doesn't look like a real selfie. Try again.", rejected: true }, 422);
      }

      const profile = { id, name, created_at: Date.now() };
      await avatars.set(id, bytes);
      await profiles.setJSON(id, profile);
      return json({ ok: true, profile: publicProfile(profile) });
    }

    // PUBLIC: leaderboard
    if (GET && action === "scores") {
      const level = url.searchParams.get("level") || "all";
      const [all, people] = await Promise.all([readAll(scores), readAll(profiles)]);
      const known = new Map(people.map(p => [p.id, p]));
      const result = all
        .filter(s => level === "all" || s.level === level)
        .sort((a, b) => b.score - a.score)
        .slice(0, 10)
        .map(s => {
          const id = profileId(s.name);
          return {
            name: s.name,
            level: s.level,
            score: s.score,
            created_at: s.created_at,
            avatar: known.has(id) ? publicProfile(known.get(id)).avatar : null
          };
        });
      return json(result);
    }

    // PUBLIC: submit a score (player must have a selfie profile)
    if (POST && action === "score") {
      const body = await req.json();
      const name = cleanName(body.name);
      const level = body.level;
      const score = Number(body.score);
      if (
        !name || !["easy", "medium", "hard"].includes(level) ||
        !Number.isFinite(score) || score < 0 || score > 100000
      ) return json({ error: "Invalid score." }, 400);

      const p = await profiles.get(profileId(name), { type: "json" });
      if (!p) return json({ error: "Take your selfie first." }, 403);

      await scores.setJSON(crypto.randomUUID(), {
        name: p.name, level, score: Math.floor(score), created_at: Date.now()
      });
      return json({ ok: true });
    }

    // ADMIN: login / check / logout
    if (POST && action === "login") {
      const { password } = await req.json();
      const saved = process.env.ADMIN_PASSWORD || "";
      if (!saved || !secret()) return json({ error: "Admin login is not configured." }, 500);
      const a = Buffer.from(String(password || ""));
      const b = Buffer.from(saved);
      if (!(a.length === b.length && crypto.timingSafeEqual(a, b))) {
        return json({ error: "Incorrect password." }, 401);
      }
      return new Response(JSON.stringify({ ok: true }), {
        headers: {
          "Content-Type": "application/json",
          "Set-Cookie": `academy_session=${makeSession()}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=604800`
        }
      });
    }

    if (GET && action === "check") return json({ loggedIn: validSession(req) });

    if (POST && action === "logout") {
      return new Response(JSON.stringify({ ok: true }), {
        headers: {
          "Content-Type": "application/json",
          "Set-Cookie": "academy_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0"
        }
      });
    }

    // Everything below requires admin login
    if (!validSession(req)) return json({ error: "Admin login required." }, 401);

    if (POST && action === "upload") {
      const form = await req.formData();
      const uploaded = form.getAll("files");
      const title = String(form.get("title") || "").trim();
      const note = String(form.get("note") || "").trim();
      if (!uploaded.length) return json({ error: "Choose at least one file." }, 400);

      const result = [];
      for (const file of uploaded) {
        if (!(file instanceof File) || file.size > 8 * 1024 * 1024) {
          return json({ error: "Each file must be 8 MB or smaller." }, 400);
        }
        const id = crypto.randomUUID();
        const name = file.name.replace(/[\/\\]/g, "_");
        await files.set(id, file, { metadata: { contentType: file.type || "application/octet-stream" } });
        const info = {
          id, title: title || name, note, name,
          type: file.type || "application/octet-stream",
          size: file.size, created_at: Date.now()
        };
        await metadata.setJSON(id, info);
        result.push(info);
      }
      return json({ ok: true, files: result });
    }

    if (POST && action === "delete") {
      const { id } = await req.json();
      if (!validId(id)) return json({ error: "Invalid file ID." }, 400);
      await files.delete(id);
      await metadata.delete(id);
      return json({ ok: true });
    }

    if (POST && action === "clear") {
      await scores.deleteAll();
      return json({ ok: true });
    }

    if (GET && action === "players") {
      const all = await readAll(profiles);
      all.sort((a, b) => b.created_at - a.created_at);
      return json(all.map(publicProfile));
    }

    if (POST && action === "resetPlayer") {
      const { id } = await req.json();
      if (!validId(id)) return json({ error: "Invalid player ID." }, 400);
      await avatars.delete(id);
      await profiles.delete(id);
      return json({ ok: true });
    }

    return json({ error: "Unknown action." }, 404);
  } catch (error) {
    console.error(error);
    return json({ error: "Server error. Please try again." }, 500);
  }
}
