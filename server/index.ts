import Fastify from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { Server } from "socket.io";
import { randomUUID, createHash } from "node:crypto";
import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import identity from "../extension/identity.json";
import { z } from "zod";
import {
  commandSchema,
  applyCommand,
  positionAt,
  type Playback,
  type Participant,
  type Snapshot,
} from "./protocol";
import { signSession, readSession, safeEqual, type Session } from "./auth";
import { createStorage } from "./storage";
import { initialInviteHash } from "./invite-config";

const production = process.env.NODE_ENV === "production";
const invite = process.env.INVITE_CODE;
if (invite && invite.length < 8)
  throw new Error("INVITE_CODE must contain at least 8 characters");
const inviteHash = invite
  ? createHash("sha256").update(invite).digest("hex")
  : initialInviteHash;
const secret =
  process.env.SESSION_SECRET ||
  createHash("sha256")
    .update(
      inviteHash + ":" + (process.env.DATABASE_URL || "local") + ":session",
    )
    .digest("hex");
const epoch = randomUUID();
const storage = await createStorage();
const saved = await storage.load();
let state: Playback = saved
  ? {
      ...saved,
      playing: false,
      anchor: Date.now(),
      revision: saved.revision + 1,
    }
  : {
      videoId: null,
      mediaRevision: 0,
      position: 0,
      playing: false,
      rate: 1,
      anchor: Date.now(),
      revision: 0,
      updatedBy: null,
    };
const app = Fastify({
  logger: {
    level: "info",
    redact: ["req.headers.cookie", "req.headers.authorization", "body.code"],
  },
  bodyLimit: 4096,
  trustProxy: production,
});
await app.register(cookie);
await app.register(rateLimit, { max: 150, timeWindow: 60000 });
const allowedOrigins = new Set(
  (
    process.env.APP_ORIGIN ||
    process.env.RENDER_EXTERNAL_URL ||
    "http://localhost:5173,http://127.0.0.1:5173,http://localhost:3000,http://127.0.0.1:3000"
  )
    .split(",")
    .map((s) => s.trim()),
);
const extensionOrigin = `chrome-extension://${identity.id}`;
allowedOrigins.add(extensionOrigin);
function validOrigin(origin: string | undefined) {
  return !!origin && allowedOrigins.has(origin);
}
app.addHook("onSend", async (_req, reply) => {
  if (_req.headers.origin === extensionOrigin) {
    reply
      .header("Access-Control-Allow-Origin", extensionOrigin)
      .header("Vary", "Origin")
      .header("Access-Control-Allow-Headers", "Content-Type, Authorization")
      .header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  }
  reply
    .header("X-Content-Type-Options", "nosniff")
    .header("Referrer-Policy", "strict-origin-when-cross-origin")
    .header("X-Frame-Options", "DENY")
    .header(
      "Permissions-Policy",
      "camera=(), microphone=(), display-capture=()",
    );
  if (production)
    reply
      .header("Strict-Transport-Security", "max-age=31536000")
      .header(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self' https://www.youtube.com https://s.ytimg.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://i.ytimg.com; frame-src https://www.youtube.com https://www.youtube-nocookie.com; connect-src 'self' wss: https://www.youtube.com; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
      );
});
app.addHook("onRequest", async (req, reply) => {
  if (req.url.startsWith("/api/")) reply.header("Cache-Control", "no-store");
  if (
    ["POST", "DELETE", "PUT", "PATCH"].includes(req.method) &&
    !validOrigin(req.headers.origin)
  )
    return reply.code(403).send({ error: "Недопустимый источник запроса." });
});
app.options("/api/extension/*", async (req, reply) =>
  validOrigin(req.headers.origin)
    ? reply.code(204).send()
    : reply.code(403).send(),
);
app.get("/api/extension/latest", async (_req, reply) => {
  const path = resolve("dist/extension/latest.json");
  if (!existsSync(path))
    return reply.code(503).send({ error: "Сборка расширения ещё не готова." });
  return JSON.parse(readFileSync(path, "utf8"));
});
app.get("/extension", async (_req, reply) =>
  reply.sendFile("extension/index.html"),
);
app.post(
  "/api/extension/login",
  { config: { rateLimit: { max: 8, timeWindow: 60000 } } },
  async (req, reply) => {
    if (req.headers.origin !== extensionOrigin)
      return reply
        .code(403)
        .send({ error: "Откройте официальное расширение tvissn." });
    const parsed = z
      .object({
        name: z
          .string()
          .trim()
          .min(1)
          .max(32)
          .refine((s) => !/[\p{C}]/u.test(s)),
        code: z.string().min(1).max(128),
      })
      .safeParse(req.body);
    if (!parsed.success)
      return reply.code(400).send({ error: "Укажите имя и код приглашения." });
    if (
      !safeEqual(
        createHash("sha256").update(parsed.data.code.trim()).digest("hex"),
        inviteHash,
      )
    )
      return reply.code(401).send({ error: "Неверный код приглашения." });
    const session: Session = {
      id: randomUUID(),
      name: parsed.data.name,
      exp: Date.now() + 7 * 86400000,
    };
    return { ...session, token: signSession(session, secret + ":extension") };
  },
);
const sessions = new Map<string, Session>();
function getSession(req: { cookies: Record<string, string | undefined> }) {
  return readSession(req.cookies.tvissn_session, secret);
}
app.get("/api/health", async () => ({ ok: true }));
app.get("/health", async () => ({ ok: true }));
app.get("/api/session", async (req, reply) => {
  const s = getSession(req);
  if (!s) return reply.code(401).send({ error: "Введите код приглашения." });
  return { name: s.name, id: s.id };
});
app.post(
  "/api/login",
  { config: { rateLimit: { max: 8, timeWindow: 60000 } } },
  async (req, reply) => {
    const parsed = z
      .object({
        code: z.string().min(1).max(128),
        name: z
          .string()
          .trim()
          .min(1)
          .max(32)
          .refine((s) => !/[\p{C}]/u.test(s)),
      })
      .safeParse(req.body);
    if (!parsed.success)
      return reply
        .code(400)
        .send({ error: "Укажите имя (до 32 символов) и код приглашения." });
    if (
      !safeEqual(
        createHash("sha256").update(parsed.data.code.trim()).digest("hex"),
        inviteHash,
      )
    )
      return reply.code(401).send({
        error: "Неверный код приглашения. Проверьте его и попробуйте снова.",
      });
    const session: Session = {
      id: randomUUID(),
      name: parsed.data.name,
      exp: Date.now() + 7 * 86400000,
    };
    reply.setCookie("tvissn_session", signSession(session, secret), {
      httpOnly: true,
      secure: production,
      sameSite: "strict",
      path: "/",
      maxAge: 7 * 86400,
    });
    return { name: session.name, id: session.id };
  },
);
app.post("/api/logout", async (req, reply) => {
  const s = getSession(req);
  if (s)
    for (const socket of io.sockets.sockets.values())
      if (socket.data.session.id === s.id) socket.disconnect(true);
  reply.clearCookie("tvissn_session", { path: "/" });
  return { ok: true };
});

const io = new Server(app.server, {
  maxHttpBufferSize: 4096,
  pingInterval: 20000,
  pingTimeout: 20000,
  cors: { origin: [...allowedOrigins], credentials: true },
  allowRequest: (req, cb) =>
    cb(null, !req.headers.origin || validOrigin(req.headers.origin)),
});
io.use((socket, next) => {
  const token = app.parseCookie(
    socket.request.headers.cookie || "",
  ).tvissn_session;
  const s =
    socket.handshake.headers.origin === extensionOrigin &&
    typeof socket.handshake.auth.token === "string"
      ? readSession(socket.handshake.auth.token, secret + ":extension")
      : readSession(token, secret);
  if (!s) return next(new Error("SESSION_EXPIRED"));
  if (io.engine.clientsCount > 50) return next(new Error("Комната заполнена."));
  socket.data.session = s;
  next();
});
const participants = new Map<string, Participant>();
function people() {
  const map = new Map<string, Participant>();
  for (const [id, p] of participants) {
    const session = sessions.get(id);
    if (session) map.set(session.id, { ...p, id: session.id });
  }
  return [...map.values()];
}
function snapshot(): Snapshot {
  return {
    playback: state,
    participants: people(),
    serverTime: Date.now(),
    epoch,
  };
}
function publish() {
  io.emit("snapshot", snapshot());
}
let chain: Promise<unknown> = Promise.resolve();
const dedup = new Map<string, number>();
io.on("connection", (socket) => {
  const s: Session = socket.data.session;
  sessions.set(socket.id, s);
  participants.set(socket.id, {
    id: s.id,
    name: s.name,
    status: state.videoId || state.externalUrl ? "connecting" : "ready",
  });
  publish();
  let count = 0,
    windowStart = Date.now();
  socket.on("clock", (_data, ack) => {
    if (typeof ack === "function") ack({ serverTime: Date.now() });
  });
  socket.on("sync", () => socket.emit("snapshot", snapshot()));
  socket.on("status", (status) => {
    if (["ready", "buffering", "connecting", "error"].includes(status)) {
      const p = participants.get(socket.id);
      if (p && p.status !== status) {
        p.status = status;
        publish();
      }
    }
  });
  socket.on("command", (raw, ack) => {
    if (typeof ack !== "function") return;
    if (Date.now() > s.exp) {
      ack({ ok: false, error: "Сессия истекла. Войдите снова." });
      socket.disconnect(true);
      return;
    }
    if (Date.now() - windowStart > 10000) {
      count = 0;
      windowStart = Date.now();
    }
    if (++count > 40) {
      ack({
        ok: false,
        error: "Слишком много действий. Подождите несколько секунд.",
      });
      return;
    }
    const c = commandSchema.safeParse(raw);
    if (!c.success) {
      ack({ ok: false, error: "Некорректная команда." });
      return;
    }
    chain = chain
      .then(async () => {
        const key = s.id + ":" + c.data.commandId;
        if (dedup.has(key)) {
          ack({ ok: true });
          return;
        }
        try {
          const next = applyCommand(state, c.data, s.name, Date.now());
          // Persist a paused checkpoint so restart never jumps ahead by the downtime.
          await storage.save({
            ...next,
            position: positionAt(next, Date.now()),
            playing: false,
            anchor: Date.now(),
          });
          state = next;
          dedup.set(key, Date.now());
          if (dedup.size > 2000)
            for (const [key, t] of dedup)
              if (Date.now() - t > 60000) dedup.delete(key);
          publish();
          ack({ ok: true });
        } catch (e) {
          ack({
            ok: false,
            error:
              e instanceof Error ? e.message : "Не удалось выполнить действие.",
          });
          socket.emit("snapshot", snapshot());
        }
      })
      .catch((e) => app.log.error(e));
  });
  socket.on("disconnect", () => {
    participants.delete(socket.id);
    sessions.delete(socket.id);
    publish();
  });
});
const heartbeat = setInterval(() => {
  for (const socket of io.sockets.sockets.values())
    if (socket.data.session.exp < Date.now()) socket.disconnect(true);
  io.emit("snapshot", snapshot());
}, 3000);
const checkpoint = setInterval(() => {
  chain = chain
    .then(() =>
      storage.save({
        ...state,
        position: positionAt(state, Date.now()),
        playing: false,
        anchor: Date.now(),
      }),
    )
    .catch((e) => app.log.error(e));
}, 15000);
if (existsSync("dist/index.html")) {
  await app.register(fastifyStatic, {
    root: resolve("dist"),
    maxAge: "1h",
    setHeaders(res, path) {
      if (path.endsWith(".html") || path.includes("/extension/"))
        res.setHeader("Cache-Control", "no-store");
    },
  });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api/"))
      return reply.code(404).send({ error: "Не найдено" });
    reply.header("Cache-Control", "no-cache");
    return reply.sendFile("index.html");
  });
}
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(heartbeat);
  clearInterval(checkpoint);
  await chain;
  await storage.save({
    ...state,
    position: positionAt(state, Date.now()),
    playing: false,
    anchor: Date.now(),
  });
  io.close();
  await app.close();
  await storage.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
await app.listen({ port: Number(process.env.PORT || 3000), host: "0.0.0.0" });
