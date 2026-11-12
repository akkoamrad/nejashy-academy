// Who is making the request?
//  - Teachers sign in with the admin password and get a signed cookie.
//  - Students are identified by their player id plus a private device key that the
//    browser saved when they created their player (or linked the device).
import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { players, deviceKeys } from "../db/schema.js";
import { hashKey, safeEqual, validId } from "./http.js";

/* ===== Teachers ===== */
const secret = () => process.env.SESSION_SECRET || "";
const sign = (value: string) => crypto.createHmac("sha256", secret()).update(value).digest("hex");

export function makeSession() {
  const data = JSON.stringify({ admin: true, expires: Date.now() + 7 * 24 * 60 * 60 * 1000 });
  const encoded = Buffer.from(data).toString("base64url");
  return encoded + "." + sign(encoded);
}

export function isAdmin(req: Request) {
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

export const adminConfigured = () => !!(process.env.ADMIN_PASSWORD && secret());

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
