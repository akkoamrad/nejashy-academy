// Who is making the request?
//  - Teachers sign in with the admin password and get a signed cookie.
//  - Students are identified by their player id plus a private device key that the
//    browser saved when they created their player (or linked the device).
import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { players, deviceKeys } from "../db/schema.js";
import { hashKey, safeEqual, validId } from "./http.js";
import type { Stores } from "./stores.js";

/* ===== Teachers ===== */
// The signing key comes from SESSION_SECRET when it is set. Otherwise a random key
// is created once and kept in the private "academy-system" blob store, so admin
// login works without any extra setup. The admin password is mixed in, so changing
// the password signs every existing admin session out.
let cachedKey = "";
async function signingKey(s: Stores) {
  if (cachedKey) return cachedKey;
  let base = process.env.SESSION_SECRET || "";
  if (!base) {
    base = (await s.system.get("session-secret")) || "";
    if (!base) {
      await s.system.set("session-secret", crypto.randomBytes(32).toString("hex"), { onlyIfNew: true });
      base = (await s.system.get("session-secret")) || "";
    }
  }
  if (!base) throw new Error("Could not load the session key.");
  const pw = crypto.createHash("sha256").update(process.env.ADMIN_PASSWORD || "").digest("hex");
  cachedKey = base + ":" + pw;
  return cachedKey;
}
const sign = (key: string, value: string) => crypto.createHmac("sha256", key).update(value).digest("hex");

export async function makeSession(s: Stores) {
  const data = JSON.stringify({ admin: true, expires: Date.now() + 7 * 24 * 60 * 60 * 1000 });
  const encoded = Buffer.from(data).toString("base64url");
  return encoded + "." + sign(await signingKey(s), encoded);
}

export async function isAdmin(req: Request, s: Stores) {
  if (!adminConfigured()) return false;
  const match = (req.headers.get("cookie") || "").match(/academy_session=([^;]+)/);
  if (!match) return false;
  const [encoded, signature] = match[1].split(".");
  if (!encoded || !signature || !safeEqual(signature, sign(await signingKey(s), encoded))) return false;
  try {
    const data = JSON.parse(Buffer.from(encoded, "base64url").toString());
    return data.admin === true && data.expires > Date.now();
  } catch {
    return false;
  }
}

export const adminConfigured = () => !!process.env.ADMIN_PASSWORD;

/* ===== Students ===== */
export type Player = typeof players.$inferSelect;

// Does this key belong to this player? (first device or any linked device)
export async function keyMatches(p: Player, key: string) {
  if (!key) return false;
  const h = hashKey(key);
  if (p.ownerKeyHash && safeEqual(h, p.ownerKeyHash)) return true;
  const [row] = await db.select({ k: deviceKeys.keyHash }).from(deviceKeys)
    .where(and(eq(deviceKeys.keyHash, h), eq(deviceKeys.playerId, p.id)));
  return !!row;
}

// Reads the X-Student-Id / X-Student-Key headers the browser sends with each request.
// Returns the player only when the key checks out.
export async function verifiedStudent(req: Request): Promise<Player | null> {
  const id = req.headers.get("x-student-id");
  const key = req.headers.get("x-student-key") || "";
  if (!validId(id) || !key) return null;
  const [p] = await db.select().from(players).where(eq(players.id, id));
  if (!p || !p.avatarVersion) return null;
  return (await keyMatches(p, key)) ? p : null;
}

// The id the browser says it is, without checking. Only used for harmless things
// like "did I already cheer this?" highlighting.
export const claimedId = (req: Request) => {
  const id = req.headers.get("x-student-id");
  return validId(id) ? id : null;
};
