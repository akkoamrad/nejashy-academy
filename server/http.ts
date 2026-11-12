// Small helpers shared by every part of the API.
import crypto from "node:crypto";

export const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });

// Thrown inside a handler to send a friendly error back to the browser.
export class HttpError extends Error {
  constructor(public status: number, message: string, public extra: Record<string, unknown> = {}) {
    super(message);
  }
}
export const fail = (status: number, message: string, extra: Record<string, unknown> = {}): never => {
  throw new HttpError(status, message, extra);
};

export const text = (v: unknown, max: number) => String(v ?? "").trim().replace(/\s+/g, " ").slice(0, max);
export const longText = (v: unknown, max: number) => String(v ?? "").trim().replace(/\r\n/g, "\n").slice(0, max);
export const optional = (v: unknown, max: number) => text(v, max) || null;
export const validId = (id: unknown): id is string => typeof id === "string" && /^[a-zA-Z0-9-]{1,64}$/.test(id);
export const intId = (v: unknown) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : fail(400, "Invalid ID.");
};
export const isDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v));
export const isTime = (v: unknown): v is string => typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);

export const hashKey = (key: string) => crypto.createHash("sha256").update(key).digest("hex");
export const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// The school's time zone decides what "today" and "this week" mean for streaks and challenges.
export const SCHOOL_TZ = process.env.SCHOOL_TIMEZONE || "Africa/Addis_Ababa";
export function dayKey(d: Date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: SCHOOL_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
// Monday of the week that `d` falls in, as YYYY-MM-DD (school time).
export function weekKey(d: Date) {
  const day = new Date(dayKey(d) + "T00:00:00Z");
  const dow = (day.getUTCDay() + 6) % 7; // 0 = Monday
  day.setUTCDate(day.getUTCDate() - dow);
  return day.toISOString().slice(0, 10);
}
export function weekStart(d: Date) {
  // Start of the school week as a real moment in time (approximate to the hour is fine for counting).
  const key = weekKey(d);
  const offset = tzOffsetMs(d);
  return new Date(Date.parse(key + "T00:00:00Z") - offset);
}
function tzOffsetMs(d: Date) {
  const local = new Date(d.toLocaleString("en-US", { timeZone: SCHOOL_TZ }));
  const utc = new Date(d.toLocaleString("en-US", { timeZone: "UTC" }));
  return local.getTime() - utc.getTime();
}
