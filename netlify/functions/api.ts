// The one API for Nejashy Academy. Every request names an "action"; this file only
// decides who is asking (teacher, verified student or anyone) and hands the work
// to the modules in /server.
import { HttpError, json } from "../../server/http.js";
import { stores } from "../../server/stores.js";
import { adminConfigured, claimedId, isAdmin, makeSession, verifiedStudent, type Player } from "../../server/auth.js";
import { safeEqual } from "../../server/http.js";
import * as players from "../../server/players.js";
import * as arena from "../../server/arena.js";
import * as feed from "../../server/feed.js";
import * as focus from "../../server/focus.js";
import * as tt from "../../server/timetable.js";
import * as school from "../../server/school.js";

type Ctx = { req: Request; url: URL; s: ReturnType<typeof stores>; b: any; admin: boolean; me: Player | null };
type Handler = (c: Ctx) => Promise<unknown> | unknown;

// Anyone can call these.
const PUBLIC_GET: Record<string, Handler> = {
  files: c => school.listFiles(c.s),
  download: c => school.download(c.url, c.s),
  profile: c => players.profile(c.url),
  avatar: c => players.avatar(c.url, c.s),
  scores: c => arena.leaderboard(c.url.searchParams.get("game") || "arena", c.url.searchParams.get("level") || "all"),
  feed: c => feed.feed(c.url, claimedId(c.req)),
  comments: c => feed.listComments(c.url),
  highlights: () => feed.highlights(),
  student: c => feed.studentProfile(c.url),
  announcements: c => school.listAnnouncements(c.me),
  communities: c => school.listCommunities(c.me),
  community: c => school.communityDetail(c.url, c.me),
  check: c => ({ loggedIn: c.admin }),
};
const PUBLIC_POST: Record<string, Handler> = {
  selfie: c => players.selfie(c.b, c.s),
  linkDevice: c => players.redeemLinkCode(c.b),
  login: c => {
    if (!adminConfigured()) return json({ error: "Admin login is not configured." }, 500);
    if (!safeEqual(String(c.b.password || ""), process.env.ADMIN_PASSWORD || "")) return json({ error: "Incorrect password." }, 401);
    return json({ ok: true }, 200, {
      "Set-Cookie": `academy_session=${makeSession()}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=604800`,
    });
  },
  logout: () => json({ ok: true }, 200, {
    "Set-Cookie": "academy_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0",
  }),
};

// A signed-in student (player id + device key) must call these.
const STUDENT_GET: Record<string, Handler> = {
  me: c => feed.me(c.me!),
  myStats: c => arena.myGameStats(c.me!),
  focusState: c => focus.focusState(c.me!),
  timetable: c => tt.timetable(c.me!),
};
const STUDENT_POST: Record<string, Handler> = {
  start: c => arena.start(c.me!, c.b),
  answer: c => arena.answer(c.me!, c.b),
  saveDetails: c => players.saveDetails(c.me!, c.b),
  linkCode: c => players.createLinkCode(c.me!),
  share: c => feed.share(c.me!, c.b),
  cheer: c => feed.cheer(c.me!, c.b),
  comment: c => feed.addComment(c.me!, c.b),
  deleteComment: c => feed.deleteComment(c.me, c.b, c.admin),
  focusStart: c => focus.startFocus(c.me!, c.b),
  focusComplete: c => focus.completeFocus(c.me!, c.b),
  focusStop: c => focus.stopFocus(c.me!, c.b),
  addPersonal: c => tt.addPersonal(c.me!, c.b),
  deletePersonal: c => tt.deletePersonal(c.me!, c.b),
  toggleAssignment: c => tt.toggleAssignment(c.me!, c.b),
  joinCommunity: c => school.joinCommunity(c.me!, c.b),
};

// Teachers only.
const ADMIN_GET: Record<string, Handler> = {
  players: () => players.listPlayers(),
  adminTimetable: () => tt.adminListTimetable(),
  adminAnnouncements: () => school.adminAnnouncements(),
};
const ADMIN_POST: Record<string, Handler> = {
  upload: c => school.upload(c.req, c.s),
  delete: c => school.deleteFile(c.b, c.s),
  clear: () => arena.clearScores(),
  resetPlayer: c => players.resetPlayer(c.b, c.s),
  setDetails: c => players.adminSetDetails(c.b),
  hideAchievement: c => feed.hideAchievement(c.b),
  adminDeleteComment: c => feed.deleteComment(null, c.b, true),
  addClass: c => tt.addClass(c.b),
  deleteClass: c => tt.deleteClass(c.b),
  addItem: c => tt.addItem(c.b),
  deleteItem: c => tt.deleteItem(c.b),
  addAnnouncement: c => school.addAnnouncement(c.b),
  pinAnnouncement: c => school.pinAnnouncement(c.b),
  deleteAnnouncement: c => school.deleteAnnouncement(c.b),
  addCommunity: c => school.addCommunity(c.b),
  deleteCommunity: c => school.deleteCommunity(c.b),
};

// These touch player data, so make sure older saved players are imported first.
const NEEDS_IMPORT = new Set(["profile", "selfie", "scores", "start", "players", "me", "linkDevice"]);

export default async function handler(req: Request) {
  try {
    const s = stores();
    const url = new URL(req.url);
    const action = url.searchParams.get("action") || "";
    const GET = req.method === "GET", POST = req.method === "POST";
    if (NEEDS_IMPORT.has(action)) await players.importLegacy(s);

    const admin = isAdmin(req);
    const isUpload = action === "upload";
    const b = POST && !isUpload ? await req.json().catch(() => ({})) : {};
    const ctx: Ctx = { req, url, s, b, admin, me: null };

    const reply = (out: unknown) => (out instanceof Response ? out : json(out));

    const pub = GET ? PUBLIC_GET[action] : POST ? PUBLIC_POST[action] : undefined;
    if (pub) {
      // Some public views (announcements, communities) are tailored to the student when known.
      if (["announcements", "communities", "community"].includes(action)) ctx.me = await verifiedStudent(req);
      return reply(await pub(ctx));
    }

    const stu = GET ? STUDENT_GET[action] : POST ? STUDENT_POST[action] : undefined;
    if (stu) {
      ctx.me = await verifiedStudent(req);
      if (!ctx.me) return json({ error: "Sign in with your selfie first.", signin: true }, 401);
      return reply(await stu(ctx));
    }

    const adm = GET ? ADMIN_GET[action] : POST ? ADMIN_POST[action] : undefined;
    if (adm) {
      if (!admin) return json({ error: "Admin login required." }, 401);
      return reply(await adm(ctx));
    }

    return json({ error: "Unknown action." }, 404);
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.message, ...error.extra }, error.status);
    console.error(error);
    return json({ error: "Server error. Please try again." }, 500);
  }
}
