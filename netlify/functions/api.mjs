import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

const files = getStore("academy-files");
const metadata = getStore("academy-file-meta");
const scores = getStore("academy-scores");

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" }
  });

function secret() {
  return process.env.SESSION_SECRET || "";
}

function sign(value) {
  return crypto
    .createHmac("sha256", secret())
    .update(value)
    .digest("hex");
}

function makeSession() {
  const data = JSON.stringify({
    admin: true,
    expires: Date.now() + 7 * 24 * 60 * 60 * 1000
  });

  const encoded = Buffer.from(data).toString("base64url");
  return encoded + "." + sign(encoded);
}

function validSession(req) {
  if (!secret()) return false;

  const cookie = req.headers.get("cookie") || "";
  const match = cookie.match(/academy_session=([^;]+)/);
  if (!match) return false;

  const [encoded, signature] = match[1].split(".");
  if (!encoded || !signature) return false;

  const expected = sign(encoded);

  if (
    signature.length !== expected.length ||
    !crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expected)
    )
  ) return false;

  try {
    const data = JSON.parse(
      Buffer.from(encoded, "base64url").toString()
    );

    return data.admin === true && data.expires > Date.now();
  } catch {
    return false;
  }
}

function requireAdmin(req) {
  return validSession(req);
}

export default async function handler(req) {
  try {
    const url = new URL(req.url);
    const action = url.searchParams.get("action");

    // PUBLIC: list files
    if (req.method === "GET" && action === "files") {
      const { blobs } = await metadata.list();
      const result = [];

      for (const item of blobs) {
        const f = await metadata.get(item.key, { type: "json" });
        if (f) result.push(f);
      }

      result.sort((a, b) => b.created_at - a.created_at);
      return json(result);
    }

    // PUBLIC: download a file
    if (req.method === "GET" && action === "download") {
      const id = url.searchParams.get("id");
      if (!id || !/^[a-zA-Z0-9-]+$/.test(id)) {
        return json({ error: "Invalid file ID" }, 400);
      }

      const info = await metadata.get(id, { type: "json" });
      if (!info) return json({ error: "File not found" }, 404);

      const blob = await files.get(id, { type: "blob" });
      if (!blob) return json({ error: "File not found" }, 404);

      return new Response(blob, {
        headers: {
          "Content-Type": info.type || "application/octet-stream",
          "Content-Disposition": `inline; filename="${encodeURIComponent(info.name)}"`,
          "Cache-Control": "public, max-age=3600"
        }
      });
    }

    // PUBLIC: leaderboard
    if (req.method === "GET" && action === "scores") {
      const level = url.searchParams.get("level") || "all";
      const { blobs } = await scores.list();
      const result = [];

      for (const item of blobs) {
        const s = await scores.get(item.key, { type: "json" });
        if (s && (level === "all" || s.level === level)) {
          result.push(s);
        }
      }

      result.sort((a, b) => b.score - a.score);
      return json(result.slice(0, 10));
    }

    // ADMIN: login
    if (req.method === "POST" && action === "login") {
      const { password } = await req.json();

      const saved = process.env.ADMIN_PASSWORD || "";

      if (!saved || !secret()) {
        return json({ error: "Admin login is not configured." }, 500);
      }

      const a = Buffer.from(String(password || ""));
      const b = Buffer.from(saved);

      const correct =
        a.length === b.length &&
        crypto.timingSafeEqual(a, b);

      if (!correct) return json({ error: "Incorrect password." }, 401);

      return new Response(JSON.stringify({ ok: true }), {
        headers: {
          "Content-Type": "application/json",
          "Set-Cookie":
            `academy_session=${makeSession()}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=604800`
        }
      });
    }

    // ADMIN: check login
    if (req.method === "GET" && action === "check") {
      return json({ loggedIn: validSession(req) });
    }

    // ADMIN: logout
    if (req.method === "POST" && action === "logout") {
      return new Response(JSON.stringify({ ok: true }), {
        headers: {
          "Content-Type": "application/json",
          "Set-Cookie":
            "academy_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0"
        }
      });
    }

    // PUBLIC: submit a score
    if (req.method === "POST" && action === "score") {
      const body = await req.json();

      const name = String(body.name || "").trim().slice(0, 20);
      const level = body.level;
      const score = Number(body.score);

      if (
        !name ||
        !["easy", "medium", "hard"].includes(level) ||
        !Number.isFinite(score) ||
        score < 0 ||
        score > 100000
      ) return json({ error: "Invalid score." }, 400);

      const id = crypto.randomUUID();

      await scores.set(id, JSON.stringify({
        name,
        level,
        score: Math.floor(score),
        created_at: Date.now()
      }));

      return json({ ok: true });
    }

    // Everything below requires admin login
    if (!requireAdmin(req)) {
      return json({ error: "Admin login required." }, 401);
    }

    // ADMIN: upload files
    if (req.method === "POST" && action === "upload") {
      const form = await req.formData();
      const uploaded = form.getAll("files");
      const title = String(form.get("title") || "").trim();
      const note = String(form.get("note") || "").trim();

      if (!uploaded.length) {
        return json({ error: "Choose at least one file." }, 400);
      }

      const result = [];

      for (const file of uploaded) {
        if (!(file instanceof File) || file.size > 8 * 1024 * 1024) {
          return json({ error: "Each file must be 8 MB or smaller." }, 400);
        }

        const id = crypto.randomUUID();
        const name = file.name.replace(/[\/\\]/g, "_");

        await files.set(id, file, {
          metadata: { contentType: file.type || "application/octet-stream" }
        });

        const info = {
          id,
          title: title || name,
          note,
          name,
          type: file.type || "application/octet-stream",
          size: file.size,
          created_at: Date.now()
        };

        await metadata.set(id, JSON.stringify(info));
        result.push(info);
      }

      return json({ ok: true, files: result });
    }

    // ADMIN: delete a file
    if (req.method === "POST" && action === "delete") {
      const { id } = await req.json();

      if (!id || !/^[a-zA-Z0-9-]+$/.test(id)) {
        return json({ error: "Invalid file ID." }, 400);
      }

      await files.delete(id);
      await metadata.delete(id);

      return json({ ok: true });
    }

    // ADMIN: clear leaderboard
    if (req.method === "POST" && action === "clear") {
      await scores.deleteAll();
      return json({ ok: true });
    }

    return json({ error: "Unknown action." }, 404);

  } catch (error) {
    console.error(error);
    return json({ error: "Server error. Please try again." }, 500);
  }
}
